// ----------------------------
// 🧩 Data Saver Background Script
// ----------------------------

// --- Content scripts, keyed by the storage setting that controls them.
// Each key maps to an ARRAY since one toggle can drive more than one script
// (e.g. "media" drives both the isolated-world blocker and the MAIN-world
// shadow-DOM patch that lets the blocker see into closed shadow roots). ---
const CONTENT_SCRIPTS = {
  media: [
    {
      id: 'data-saver-media-blocker',
      matches: ['<all_urls>'],
      js: ['stop_all_media.js'],
      runAt: 'document_start',
      allFrames: true
    },
    {
      id: 'data-saver-open-shadow-dom',
      matches: ['<all_urls>'],
      js: ['force_open_shadow_dom.js'],
      runAt: 'document_start',
      allFrames: true,
      world: 'MAIN'
    }
  ],
  images: [
    {
      id: 'data-saver-image-cleanup',
      matches: ['<all_urls>'],
      js: ['hide_broken_images.js'],
      runAt: 'document_start',
      allFrames: true
    }
  ]
};

// The savings counter isn't owned by any single toggle — it observes whatever
// the other layers block, so it runs whenever ANY blocking is switched on and
// stops entirely when everything is off (nothing to count, no reason to inject).
const COUNTER_SCRIPT = {
  id: 'data-saver-savings-counter',
  matches: ['<all_urls>'],
  js: ['savings_counter.js'],
  runAt: 'document_start',
  allFrames: true
};

// Reserved id range for the per-site "pause on this site" dynamic rules
// (see syncAllowlistDynamicRules), kept distinct from anything else that
// might one day also use chrome.declarativeNetRequest.updateDynamicRules.
const ALLOWLIST_RULE_PRIORITY = 1000; // above every static block rule

// ----------------------------
// 📊 Savings estimation
// ----------------------------
// Average transfer size per blocked request, in bytes. These are deliberately
// CONSERVATIVE — roughly the low end of HTTP Archive's median transfer sizes —
// because a savings meter that flatters itself is worse than no meter at all.
// The popup presents the result as an estimate and the request count, which is
// exact, is shown alongside it.
const AVG_BYTES = {
  ads: 30 * 1024,     // ad/analytics scripts and ad iframes
  images: 35 * 1024,  // a typical web image after the page's own compression
  media: 300 * 1024   // one blocked segment/poster, not a whole video
};

const EMPTY_STATS = { ads: 0, images: 0, media: 0, bytes: 0, since: null };

function estimateBytes(counts) {
  return (counts.ads || 0) * AVG_BYTES.ads
    + (counts.images || 0) * AVG_BYTES.images
    + (counts.media || 0) * AVG_BYTES.media;
}

// chrome.storage is read-modify-write, and several tabs can report blocked
// requests in the same tick. Chaining every update onto a single promise keeps
// those increments from overwriting one another.
let statsQueue = Promise.resolve();

function recordBlocked(counts) {
  statsQueue = statsQueue.then(async () => {
    const { stats } = await chrome.storage.local.get({ stats: EMPTY_STATS });

    const next = {
      ads: (stats.ads || 0) + (counts.ads || 0),
      images: (stats.images || 0) + (counts.images || 0),
      media: (stats.media || 0) + (counts.media || 0),
      // Accumulated here rather than derived in the popup so AVG_BYTES has
      // exactly one definition — a second copy in popup.js would drift.
      bytes: (stats.bytes || 0) + estimateBytes(counts),
      // Stamped on first write rather than at install, so the popup can say
      // "since <date>" truthfully even for users who upgrade into this feature.
      since: stats.since || Date.now()
    };

    await chrome.storage.local.set({ stats: next });
  }).catch((e) => {
    console.warn('⚠️ Could not record blocked requests:', e);
  });

  return statsQueue;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ds-blocked' && msg.counts) {
    // Frames need a blocklist lookup before they can be counted, so fold the
    // result into the same stats write rather than doing two.
    countBlockedFrames(msg.frames)
      .catch(() => 0)
      .then((frames) => {
        const counts = Object.assign({}, msg.counts);
        counts.ads = (counts.ads || 0) + frames;
        return recordBlocked(counts);
      });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'ds-toggle-site' && msg.hostname) {
    toggleSite(msg.hostname)
      .then((paused) => sendResponse({ ok: true, paused }))
      // The popup disables its button until this replies, so a silent rejection
      // would leave it stuck and the popup never closing. Always answer.
      .catch((e) => {
        console.warn('⚠️ Could not toggle site:', e);
        sendResponse({ ok: false });
      });
    return true; // keep the channel open for the async reply
  }

  // The popup asks rather than testing membership itself, so subdomain
  // matching has exactly one implementation.
  if (msg.type === 'ds-site-state' && msg.hostname) {
    chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
      sendResponse({ ok: true, paused: isAllowlisted(msg.hostname, allowlist) });
    });
    return true;
  }
});

// ----------------------------
// ⏸️ Per-site pause — the primary escape hatch
// ----------------------------
// Blocking is deliberately aggressive on every site, so "make this one site
// work" has to be the easiest thing in the product to reach. It is exposed
// three ways: the primary button at the top of the popup, a keyboard shortcut,
// and a badge on the toolbar icon so the current state is visible without
// opening anything. This function is the single implementation behind all of
// them — the popup used to write the allowlist itself, which would have meant
// two copies of this logic the moment the shortcut existed.

// Sites that ship unblocked.
//
// THE TEST FOR ADDING ONE: blocking must make the site's primary function
// IMPOSSIBLE, not merely worse. YouTube qualifies — the page loads and nothing
// ever plays, so the extension reads as broken rather than working. Facebook
// and X do not: with images off they are plainer, but posting, reading and
// messaging all still work, and they are exactly the data-hungry sites someone
// installed a data saver to tame. Allowlisting merely-degraded sites is how a
// data saver quietly stops saving data.
//
// Every entry is an ordinary allowlist entry, so "Resume blocking here" removes
// it like any other, and subdomains are covered (see allowlistEntryFor).
const DEFAULT_ALLOWLIST = [
  // --- Video-on-demand: people arrive here to watch, and know it costs data
  'youtube.com',
  'netflix.com',
  'primevideo.com',
  'disneyplus.com',
  'hulu.com',
  'max.com',
  'paramountplus.com',
  'peacocktv.com',
  'crunchyroll.com',
  'vimeo.com',
  'dailymotion.com',

  // --- India is the largest single market for this extension (~24% of
  // installs), so its streaming services belong here as much as the US ones
  'hotstar.com',
  'jiocinema.com',
  'sonyliv.com',
  'zee5.com',
  'mxplayer.in',

  // --- Live streaming
  'twitch.tv',
  'kick.com',
  'rumble.com',

  // --- Large non-Western video platforms
  'bilibili.com',
  'iqiyi.com',
  'youku.com',

  // --- Short-form video: there is no text mode to fall back to
  'tiktok.com',
  'instagram.com',

  // --- Audio streaming. Not video, but the same test applies: nothing plays
  // with media blocking on, and the user came here knowing it streams.
  'spotify.com',
  'soundcloud.com',

  // --- Calls. Different reasoning from the rest: not somewhere people go to
  // consume media, but media blocking must never be the reason someone drops
  // a meeting. The cost of being wrong here dwarfs the data saved.
  'meet.google.com',
  'zoom.us',
  'teams.microsoft.com',
  'whereby.com'
];

function hostnameOf(url) {
  try {
    return new URL(url).hostname || null;
  } catch (e) {
    return null; // chrome://, about:, file:// without a host
  }
}

// The allowlist's DNR rule is `||domain^` and its script pattern is
// `*://*.domain/*`, both of which cover subdomains. So membership has to be
// tested the same way — otherwise the popup reports "Blocking active" on
// www.youtube.com while the rules are quietly allowing it.
function allowlistEntryFor(hostname, allowlist) {
  return allowlist.find((d) => hostname === d || hostname.endsWith('.' + d)) || null;
}

function isAllowlisted(hostname, allowlist) {
  return allowlistEntryFor(hostname, allowlist) !== null;
}

// Every manual press of the popup button or the keyboard shortcut is recorded
// in `userChoices` as an explicit decision, separately from the effective
// allowlist. The allowlist alone cannot distinguish "the user chose this" from
// "we shipped this as a default", and that difference decides who wins when the
// two disagree: a person's deliberate choice must survive any future change to
// DEFAULT_ALLOWLIST, in either direction. Without this, adding a site to the
// defaults would silently unblock it for someone who had chosen to block it,
// and dropping one would re-block a site someone had chosen to allow.
//   userChoices[host] === true   -> the user chose NOT to block this site
//   userChoices[host] === false  -> the user chose TO block it
function toggleSite(hostname) {
  return chrome.storage.sync
    .get({ allowlist: [], userChoices: {} })
    .then(({ allowlist, userChoices }) => {
      // Resuming on www.youtube.com has to drop the `youtube.com` entry that is
      // actually covering it, not add a narrower one that changes nothing.
      const covering = allowlistEntryFor(hostname, allowlist);
      const key = covering || hostname;

      const next = covering
        ? allowlist.filter((d) => d !== covering)
        : [...allowlist, hostname];

      const choices = Object.assign({}, userChoices);
      choices[key] = !covering; // pressing while covered means "block here again"

      return chrome.storage.sync
        .set({ allowlist: next, userChoices: choices })
        .then(() => !covering);
    });
}

// Applied once per entry, not as a read-time default: a `get` default only
// fires while the key is absent, so existing users who had ever used pause
// would silently miss new defaults while everyone else got them.
//
// `seededDefaults` records which entries have EVER been offered, rather than a
// single "done" flag. That matters because this list grows: with a boolean,
// adding a site later would re-add every earlier default too, silently undoing
// the choice of anyone who had resumed blocking on one. Offering each entry
// exactly once means a user's removal sticks permanently.
function seedDefaultAllowlist() {
  return chrome.storage.sync
    .get({ allowlist: [], seededDefaults: null, defaultsSeeded: false, userChoices: {} })
    .then(({ allowlist, seededDefaults, defaultsSeeded, userChoices }) => {
      // Migrate v2.2's boolean flag, which only ever covered youtube.com.
      const offered = seededDefaults || (defaultsSeeded ? ['youtube.com'] : []);

      const toAdd = DEFAULT_ALLOWLIST.filter((d) =>
        // Never offered before, AND the user has not explicitly said they want
        // this one blocked. The second half is what makes a deliberate choice
        // permanent even if this site is added to the defaults later.
        !offered.includes(d) && userChoices[d] !== false
      );

      if (!toAdd.length && seededDefaults) return;

      return chrome.storage.sync.set({
        allowlist: [...new Set([...allowlist, ...toAdd])],
        seededDefaults: [...new Set([...offered, ...DEFAULT_ALLOWLIST])]
      });
    });
}

// ----------------------------
// 🖼️ Blocked-frame lookup
// ----------------------------
// A blocked iframe fires 'load', not 'error' (measured — see
// scripts/probe-events.py), so the content script cannot tell a blocked frame
// from a real cross-origin one. It sends the hostname here instead, where the
// actual blocklist lives and the answer is definitive rather than a guess.
//
// The domain set is built lazily and cached: parsing the ~1MB ruleset costs
// nothing until a page actually has a cross-origin frame, and most do not.
let blockedDomains = null;
let blockedDomainsLoading = null;

function loadBlockedDomains() {
  if (blockedDomains) return Promise.resolve(blockedDomains);
  if (blockedDomainsLoading) return blockedDomainsLoading;

  blockedDomainsLoading = fetch(chrome.runtime.getURL('rules/ad-domains.json'))
    .then((r) => r.json())
    .then((rules) => {
      const set = new Set();
      for (const rule of rules) {
        // Rules are generated as `||domain^`; recover the bare domain.
        const filter = rule.condition && rule.condition.urlFilter;
        if (!filter) continue;
        const domain = filter.replace(/^\|\|/, '').replace(/\^$/, '');
        if (domain) set.add(domain);
      }
      blockedDomains = set;
      blockedDomainsLoading = null;
      return set;
    })
    .catch((e) => {
      console.warn('⚠️ Could not load the blocklist for frame counting:', e);
      blockedDomainsLoading = null;
      // An empty set means frames simply go uncounted, which is the same
      // behaviour as before this existed — never a wrong count.
      blockedDomains = new Set();
      return blockedDomains;
    });

  return blockedDomainsLoading;
}

function countBlockedFrames(hosts) {
  if (!hosts || !hosts.length) return Promise.resolve(0);

  return Promise.all([
    loadBlockedDomains(),
    chrome.storage.sync.get({ allowlist: [], ads: true })
  ]).then(([domains, { allowlist, ads }]) => {
    // If ad blocking is off, or this whole site is allowlisted, nothing was
    // blocked and counting any of it would be a lie.
    if (!ads) return 0;

    let n = 0;
    for (const host of hosts) {
      if (isAllowlisted(host, allowlist)) continue;
      if (domainInSet(host, domains)) n++;
    }
    return n;
  });
}

// `||domain^` covers subdomains, so walk up the labels rather than scanning the
// whole set — this runs per frame and the set has thousands of entries.
function domainInSet(host, set) {
  if (set.has(host)) return true;
  let i = host.indexOf('.');
  while (i !== -1) {
    if (set.has(host.slice(i + 1))) return true;
    i = host.indexOf('.', i + 1);
  }
  return false;
}

function updateBadge(tabId, url) {
  const host = hostnameOf(url);
  if (!host) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
    const paused = isAllowlisted(host, allowlist);
    chrome.action.setBadgeText({ tabId, text: paused ? 'OFF' : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#55555b' });
    chrome.action.setTitle({
      tabId,
      title: paused ? `Data Saver — paused on ${host}` : 'Data Saver'
    });
  });
}

function refreshAllBadges() {
  chrome.tabs.query({}, (tabs) => {
    void chrome.runtime.lastError;
    for (const t of tabs || []) if (t.id != null) updateBadge(t.id, t.url);
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-site') return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const host = tab && hostnameOf(tab.url);
    if (!host) return;
    toggleSite(host)
      .then(() => {
        // Rules and content scripts only affect future requests, so the page
        // has to reload for the change to be visible — same as the popup's
        // button. Only reload if the write actually landed; reloading after a
        // failed toggle just looks like the shortcut did nothing.
        if (tab.id != null) chrome.tabs.reload(tab.id);
      })
      .catch((e) => console.warn('⚠️ Could not toggle site from shortcut:', e));
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    void chrome.runtime.lastError;
    if (tab) updateBadge(tabId, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') updateBadge(tabId, tab.url);
});

// ----------------------------
// 🌐 Per-site allowlist helpers
// ----------------------------
// A paused site needs to be excluded from BOTH layers: the DNR rulesets
// (network-level blocking) and the content scripts (DOM-level blocking,
// including the MAIN-world shadow-DOM patch — that script can't check
// chrome.storage itself since MAIN-world scripts have no extension API
// access, so exclusion has to happen at the registration layer instead).
function allowlistMatchPatterns(allowlist) {
  const patterns = [];
  for (const domain of allowlist) {
    patterns.push(`*://${domain}/*`);
    patterns.push(`*://*.${domain}/*`);
  }
  return patterns;
}

function syncAllowlistDynamicRules(allowlist) {
  chrome.declarativeNetRequest.getDynamicRules((existingRules) => {
    const removeRuleIds = existingRules.map((r) => r.id);
    const addRules = allowlist.map((domain, i) => ({
      id: i + 1,
      priority: ALLOWLIST_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ['main_frame']
      }
    }));
    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }, () => {
      if (chrome.runtime.lastError) {
        console.warn('⚠️ Error syncing allowlist dynamic rules:', chrome.runtime.lastError.message);
        return;
      }
      console.log('🟢 Allowlist synced:', allowlist);
    });
  });
}

// ----------------------------
// 🎬 Content Script Management
// ----------------------------
function registerScripts(scripts, isEnabled, allowlist) {
  const excludeMatches = allowlistMatchPatterns(allowlist);
  const withExclusions = scripts.map((s) => ({ ...s, excludeMatches }));
  const ids = withExclusions.map((s) => s.id);

  // Always unregister first, then re-register if enabled. That's the
  // simplest way to guarantee excludeMatches is up to date whenever the
  // allowlist changes, not just when the feature toggle itself changes.
  chrome.scripting.unregisterContentScripts({ ids }, () => {
    void chrome.runtime.lastError; // ignore "not currently registered" on first run
    if (!isEnabled) return;
    chrome.scripting.registerContentScripts(withExclusions, () => {
      if (chrome.runtime.lastError) {
        console.warn(`⚠️ registerContentScripts (${ids.join(', ')}) error:`, chrome.runtime.lastError.message);
      }
    });
  });
}

function updateContentScript(key, isEnabled, allowlist) {
  registerScripts(CONTENT_SCRIPTS[key], isEnabled, allowlist);
}

// ----------------------------
// ⚙️ DNR Ruleset Management
// ----------------------------
function applyRulesetState(ads, images, media) {
  const enableRulesetIds = [];
  const disableRulesetIds = [];

  if (ads) enableRulesetIds.push('ads', 'ad-domains'); else disableRulesetIds.push('ads', 'ad-domains');
  if (images) enableRulesetIds.push('images'); else disableRulesetIds.push('images');
  if (media) enableRulesetIds.push('media'); else disableRulesetIds.push('media');

  chrome.declarativeNetRequest.updateEnabledRulesets(
    { enableRulesetIds, disableRulesetIds },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('⚠️ Error updating DNR rulesets:', chrome.runtime.lastError.message);
        return;
      }
      console.log('🔄 DNR rulesets enabled:', enableRulesetIds);
    }
  );
}

// ----------------------------
// 🔄 Reconcile all state from storage
// ----------------------------
function refreshAll(data) {
  const { ads, images, media, allowlist } = data;
  applyRulesetState(ads, images, media);
  updateContentScript('media', media, allowlist);
  updateContentScript('images', images, allowlist);
  registerScripts([COUNTER_SCRIPT], ads || images || media, allowlist);
  syncAllowlistDynamicRules(allowlist);
}

function loadAndSetInitialState() {
  chrome.storage.sync.get({ ads: true, images: true, media: true, allowlist: [] }, refreshAll);
}

// ----------------------------
// 🚀 Event Listeners
// ----------------------------
chrome.runtime.onInstalled.addListener((details) => {
  console.log('🚀 Data Saver Extension installed');
  // Seed before reconciling so the first ruleset sync already reflects it.
  // The catch is load-bearing: seeding is a nice-to-have, but reconciling is
  // what actually turns blocking on. Without it a rejected storage write (sync
  // disabled, quota, a transient error) skips loadAndSetInitialState entirely
  // and the extension installs INERT — no rulesets, no content scripts, no
  // blocking, no error anyone would ever see. Failing to seed must degrade to
  // "defaults missing", never to "extension does nothing".
  seedDefaultAllowlist()
    .catch((e) => console.warn('⚠️ Could not seed default allowlist:', e))
    .then(() => {
      loadAndSetInitialState();
      refreshAllBadges();
    });

  // Blocking starts the moment this runs, so a brand-new user's next page load
  // looks broken with no explanation. The welcome tab is the explanation — it
  // is shown on first install only, never on update, and never on a browser
  // profile that already had the extension.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log('🔁 Browser restarted — ensuring clean rules & scripts');
  // Clean stale scripts before re-registering
  const ids = Object.values(CONTENT_SCRIPTS).flat().map((s) => s.id);
  ids.push(COUNTER_SCRIPT.id);
  chrome.scripting.unregisterContentScripts({ ids }, () => {
    void chrome.runtime.lastError;
    loadAndSetInitialState();
    refreshAllBadges();
  });
});

// ----------------------------
// 🧠 React to Settings Changes (single source of truth)
// ----------------------------
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync') return;
  if (changes.ads || changes.images || changes.media || changes.allowlist) {
    chrome.storage.sync.get({ ads: true, images: true, media: true, allowlist: [] }, refreshAll);
  }
  // The allowlist can change from the popup, the keyboard shortcut, or a sync
  // from another device — repaint every tab's badge rather than just the one.
  if (changes.allowlist) refreshAllBadges();
});
