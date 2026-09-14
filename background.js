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
    recordBlocked(msg.counts);
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'ds-toggle-site' && msg.hostname) {
    toggleSite(msg.hostname).then((paused) => sendResponse({ ok: true, paused }));
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

// Sites that ship unblocked. YouTube simply does not work with media blocking
// on — the page loads and nothing plays — so shipping it blocked by default
// trains people to believe the extension is broken rather than working. It is
// a normal allowlist entry, so "Resume blocking here" removes it like any other.
const DEFAULT_ALLOWLIST = ['youtube.com'];

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

function toggleSite(hostname) {
  return chrome.storage.sync.get({ allowlist: [] }).then(({ allowlist }) => {
    // Resuming on www.youtube.com has to drop the `youtube.com` entry that is
    // actually covering it, not add a narrower one that changes nothing.
    const covering = allowlistEntryFor(hostname, allowlist);
    const next = covering
      ? allowlist.filter((d) => d !== covering)
      : [...allowlist, hostname];
    return chrome.storage.sync.set({ allowlist: next }).then(() => !covering);
  });
}

// Applied once, not as a read-time default: a `get` default only fires while
// the key is absent, so existing users who had ever used pause would silently
// miss the new default while everyone else got it. The flag also means that
// once someone resumes blocking on YouTube, it stays resumed.
function seedDefaultAllowlist() {
  return chrome.storage.sync
    .get({ allowlist: [], defaultsSeeded: false })
    .then(({ allowlist, defaultsSeeded }) => {
      if (defaultsSeeded) return;
      const merged = [...new Set([...allowlist, ...DEFAULT_ALLOWLIST])];
      return chrome.storage.sync.set({ allowlist: merged, defaultsSeeded: true });
    });
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
    toggleSite(host).then(() => {
      // Rules and content scripts only affect future requests, so the page has
      // to reload for the change to be visible — same as the popup's button.
      if (tab.id != null) chrome.tabs.reload(tab.id);
    });
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
  seedDefaultAllowlist().then(() => {
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
