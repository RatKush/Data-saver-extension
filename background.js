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

// Premium layers. Both are off by default and gated on isPro(): consent
// answering touches what a site records about the user, and popup blocking
// changes page behaviour, so neither should switch itself on.
const CONSENT_SCRIPT = {
  id: 'data-saver-consent',
  matches: ['<all_urls>'],
  js: ['consent_buster.js'],
  runAt: 'document_idle',
  allFrames: false
};

const POPUP_SCRIPT = {
  id: 'data-saver-popups',
  matches: ['<all_urls>'],
  js: ['popup_blocker.js'],
  runAt: 'document_start',
  allFrames: true,
  // window.open has to be replaced on the page's own window object, which is
  // only reachable from the MAIN world — the same reason
  // force_open_shadow_dom.js runs there.
  world: 'MAIN'
};

// Reserved id range for the per-site "pause on this site" dynamic rules
// (see syncAllowlistDynamicRules), kept distinct from anything else that
// might one day also use chrome.declarativeNetRequest.updateDynamicRules.
const ALLOWLIST_RULE_PRIORITY = 1000; // above every static block rule
const SITE_PROFILE_RULE_PRIORITY = 900;  // above the statics, below a full pause

// ----------------------------
// 🔑 Entitlement
// ----------------------------
// The premium features below are built and fully working; pricing is not
// decided yet. This is the ONE place a paywall would attach, so adding it
// later is a change to this function rather than a refactor of every caller.
// Returning true means everything is unlocked, which is the current state.
function isPro() {
  return true;
}

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

// ----------------------------
// 📈 Savings history
// ----------------------------
// The meter shows one lifetime total, which tells a user nothing about whether
// last week was better than this one. These two structures are what turn that
// number into a trend and a "worst offenders" list.
//
// PRIVACY. siteStats records HOSTNAMES the user visited where something was
// blocked. That never leaves the device — there is no server to send it to —
// so the store's data-use answers are unchanged, but it is still a real record
// of browsing and is treated as one: capped, prunable, and cleared by its own
// control separately from the rest of the stats.
const HISTORY_DAYS = 60;
const SITE_STATS_MAX = 50;

function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

// Pure, so the pruning rules can be tested without a browser.
function addToHistory(history, counts, bytes, now) {
  const out = Object.assign({}, history);
  const key = dayKey(now);
  const day = Object.assign({ ads: 0, images: 0, media: 0, bytes: 0 }, out[key]);

  day.ads += counts.ads || 0;
  day.images += counts.images || 0;
  day.media += counts.media || 0;
  day.bytes += bytes || 0;
  out[key] = day;

  // Keep a rolling window. Sorting the keys rather than comparing dates keeps
  // this correct across month and year boundaries for free.
  const keys = Object.keys(out).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - HISTORY_DAYS))) delete out[k];
  return out;
}

function addToSiteStats(siteStats, host, counts, bytes) {
  if (!host) return siteStats || {};
  const out = Object.assign({}, siteStats);
  const total = (counts.ads || 0) + (counts.images || 0) + (counts.media || 0);
  const entry = Object.assign({ n: 0, bytes: 0 }, out[host]);
  entry.n += total;
  entry.bytes += bytes || 0;
  out[host] = entry;

  // Cap the list rather than letting it grow with every site ever visited.
  // Dropping the smallest keeps the "worst offenders" the feature is for.
  const hosts = Object.keys(out);
  if (hosts.length > SITE_STATS_MAX) {
    hosts.sort((a, b) => out[b].n - out[a].n);
    for (const h of hosts.slice(SITE_STATS_MAX)) delete out[h];
  }
  return out;
}

// chrome.storage is read-modify-write, and several tabs can report blocked
// requests in the same tick. Chaining every update onto a single promise keeps
// those increments from overwriting one another.
let statsQueue = Promise.resolve();

function recordBlocked(counts, host, now = Date.now()) {
  statsQueue = statsQueue.then(async () => {
    const { stats, history, siteStats } = await chrome.storage.local.get({
      stats: EMPTY_STATS, history: {}, siteStats: {}
    });

    // Which sites were visited is the only browsing-shaped record this
    // extension keeps, so it is OFF unless the user asks for it. Read here
    // rather than at the call site so there is exactly one gate: no caller
    // can record a hostname by forgetting to check.
    const { siteHistory } = await chrome.storage.sync.get({ siteHistory: false });

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

    const bytes = estimateBytes(counts);
    await chrome.storage.local.set({
      stats: next,
      history: addToHistory(history, counts, bytes, now),
      siteStats: addToSiteStats(siteStats, siteHistory ? host : null, counts, bytes)
    });
  }).catch((e) => {
    console.warn('⚠️ Could not record blocked requests:', e);
  });

  return statsQueue;
}

// ----------------------------
// ⭐ Review prompt
// ----------------------------
// The listing has no ratings at all, which suppresses both search ranking and
// click-through. Asking is worth doing — but asking the WRONG user is not, and
// a rating is permanent and public. Hence two conditions, both required.
//
// WHY A COUNT AND NOT MEGABYTES
// The obvious threshold is "500 MB saved", but stats.bytes is a weighted guess
// built from AVG_BYTES (ads 30 KB / images 35 KB / media 300 KB), so a
// media-heavy user reaches any MB figure roughly nine times faster than an
// image-heavy one for the same amount of blocking. That would fire the prompt
// on our own weighting rather than on the user's experience. The blocked count
// is exact, it is the figure the meter leads with, and it is the number on
// screen when the prompt appears. 15,000 is calibrated to the bar 500 MB set:
// real page mixes measured ~34-35 KB per blocked request (see scripts/e2e-edge.py),
// which puts 500 MB at ~14,800.
//
// WHY 15 DAYS AND NOT 7
// Cohort churn is front-loaded — the install, see-a-stripped-page, uninstall
// reaction happens in the first few days. A 7-day prompt catches people
// mid-wobble. At 15 days the user has survived the risky window and has a real
// number to point at, which is who should be supplying the listing's first
// ratings.
const REVIEW_MIN_BLOCKED = 15000;
const REVIEW_MIN_DAYS = 15;
const REVIEW_SNOOZE_DAYS = 20;
const REVIEW_MAX_ASKS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

const EMPTY_REVIEW = { asks: 0, snoozeUntil: null, done: false };

// Pure so it can be tested without a browser. Every rejection is explicit:
// a missing or unparseable input means DON'T ask, never "ask anyway".
function shouldAskForReview({ stats, review, installedAt, now }) {
  const r = review || EMPTY_REVIEW;

  // Already rated, or already asked as often as we are willing to. Two asks is
  // the whole budget — a third would be nagging, and nagging earns one star.
  if (r.done) return false;
  if ((r.asks || 0) >= REVIEW_MAX_ASKS) return false;
  if (r.snoozeUntil && now < r.snoozeUntil) return false;

  const s = stats || {};
  const total = (s.ads || 0) + (s.images || 0) + (s.media || 0);
  if (total < REVIEW_MIN_BLOCKED) return false;

  // installedAt is stamped in onInstalled. stats.since is the fallback for
  // anyone who was already running the extension when that was added; it is
  // stamped on the first blocked request, so it is never later than the real
  // install and can only make us wait longer, which is the safe direction.
  const start = installedAt || s.since;
  if (!start) return false;
  if (now - start < REVIEW_MIN_DAYS * DAY_MS) return false;

  return true;
}

async function getReviewState(now = Date.now()) {
  const { stats, review, installedAt } = await chrome.storage.local.get({
    stats: EMPTY_STATS,
    review: EMPTY_REVIEW,
    installedAt: null
  });
  const s = stats || EMPTY_STATS;
  return {
    show: shouldAskForReview({ stats: s, review, installedAt, now }),
    total: (s.ads || 0) + (s.images || 0) + (s.media || 0)
  };
}

// 'rated' closes the prompt permanently. 'later' spends one of the two asks
// and pushes the next one out; once the budget is gone shouldAskForReview
// stops returning true on its own, so there is no separate opt-out to store.
async function recordReviewAction(action, now = Date.now()) {
  const { review } = await chrome.storage.local.get({ review: EMPTY_REVIEW });
  const r = Object.assign({}, EMPTY_REVIEW, review);

  if (action === 'rated') {
    r.done = true;
  } else {
    r.asks = (r.asks || 0) + 1;
    r.snoozeUntil = now + REVIEW_SNOOZE_DAYS * DAY_MS;
  }

  await chrome.storage.local.set({ review: r });
  return r;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ds-blocked' && msg.counts) {
    // Frames need a blocklist lookup before they can be counted, so fold the
    // result into the same stats write rather than doing two.
    const host = hostnameOf(sender && sender.tab && sender.tab.url);
    countBlockedFrames(msg.frames)
      .catch(() => 0)
      .then((frames) => {
        const counts = Object.assign({}, msg.counts);
        counts.ads = (counts.ads || 0) + frames;
        return recordBlocked(counts, host);
      })
      // Never let a budget re-check break the counting it rides on.
      .then(() => ensureBudgetStage())
      .catch((e) => console.warn('⚠️ Could not re-check the data budget:', e));
    sendResponse({ ok: true });
    return false;
  }

  // Auto-mode's input. The page reports what navigator.connection says; the
  // service worker cannot read it meaningfully for the active tab itself.
  // Worth being precise about what this is: effectiveType is a SPEED ESTIMATE
  // and saveData is the user's own browser flag. Chrome exposes no "is this
  // connection metered" signal on desktop, so this is a good heuristic and is
  // never treated as more than one.
  if (msg.type === 'ds-connection') {
    const fast = msg.effectiveType === '4g' && !msg.saveData;
    chrome.storage.local.get({ autoState: null }, ({ autoState }) => {
      // Only write when the verdict actually flips, or every page load would
      // rewrite storage and re-run the whole reconcile.
      if (autoState && autoState.fast === fast) return;
      chrome.storage.local.set({ autoState: { fast, at: Date.now() } });
    });
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'ds-site-profile' && msg.hostname) {
    setSiteProfile(msg.hostname, msg.profile)
      .then((profile) => sendResponse({ ok: true, profile }))
      .catch((e) => {
        console.warn('⚠️ Could not save site profile:', e);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (msg.type === 'ds-export') {
    exportPolicy()
      .then((policy) => sendResponse({ ok: true, policy }))
      .catch((e) => {
        console.warn('⚠️ Could not export settings:', e);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (msg.type === 'ds-import' && msg.policy) {
    importPolicy(msg.policy)
      .then((applied) => sendResponse({ ok: true, applied }))
      .catch((e) => {
        console.warn('⚠️ Could not import settings:', e);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
    return true;
  }

  if (msg.type === 'ds-budget-state') {
    chrome.storage.sync
      .get({ budgetEnabled: false, budgetMB: 0, budgetResetDay: 1, budgetEase: null })
      .then((cfg) => {
        if (!cfg.budgetEnabled) { sendResponse({ enabled: false }); return; }
        const { stage, cycle } = budgetStage({
          budgetMB: cfg.budgetMB,
          budgetResetDay: cfg.budgetResetDay,
          budgetEase: cfg.budgetEase,
          now: Date.now()
        });
        sendResponse({
          enabled: true,
          stage,
          day: cycle.dayIndex,
          days: cycle.days,
          eased: Boolean(cfg.budgetEase && cfg.budgetEase.cycleStart === cycle.start)
        });
      })
      .catch((e) => {
        console.warn('⚠️ Could not read the data budget:', e);
        sendResponse({ enabled: false });
      });
    return true;
  }

  if (msg.type === 'ds-budget-ease') {
    easeBudget()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.warn('⚠️ Could not ease the data budget:', e);
        sendResponse({ ok: false });
      });
    return true;
  }

  if (msg.type === 'ds-review-state') {
    getReviewState()
      // Same rule as every other handler here: always answer. The popup keeps
      // the card hidden until this replies, so a silent rejection is safe, but
      // a hung channel is not.
      .then((state) => sendResponse(state))
      .catch((e) => {
        console.warn('⚠️ Could not read review state:', e);
        sendResponse({ show: false, total: 0 });
      });
    return true;
  }

  if (msg.type === 'ds-review-action') {
    recordReviewAction(msg.action === 'rated' ? 'rated' : 'later')
      .then(() => sendResponse({ ok: true }))
      .catch((e) => {
        console.warn('⚠️ Could not record review action:', e);
        sendResponse({ ok: false });
      });
    return true;
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
// ----------------------------
// 🎛️ Per-site profiles
// ----------------------------
// The allowlist is all-or-nothing: blocking is either on for a site or off.
// A profile is the middle ground — "block ads here but let the images
// through" — stored as a partial override of the three global switches.
//
//   siteProfiles = { "example.com": { images: false } }
//
// Only keys that DIFFER from the user's global setting are stored, so a
// profile stays correct when the global switch is later flipped. A site with
// no profile, or an empty one, behaves exactly as before.
//
// Matching is subdomain-aware for the same reason the allowlist is: the DNR
// condition below uses initiatorDomains, which already covers subdomains, so
// the stored key must too or the popup and the rules would disagree.
const PROFILE_KEYS = ['ads', 'images', 'media'];

function profileEntryFor(hostname, siteProfiles) {
  if (!hostname || !siteProfiles) return null;
  const keys = Object.keys(siteProfiles);
  // Longest match wins, so a profile on news.example.com beats one on
  // example.com rather than depending on object key order.
  let best = null;
  for (const d of keys) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

// What actually applies on this host, after the site's overrides are laid
// over the global switches. Used by the rules, the content scripts and the
// popup, so all three cannot drift.
function effectiveSettings(hostname, data) {
  const base = { ads: data.ads, images: data.images, media: data.media };
  const key = profileEntryFor(hostname, data.siteProfiles);
  if (!key) return base;
  const profile = data.siteProfiles[key] || {};
  for (const k of PROFILE_KEYS) {
    if (typeof profile[k] === 'boolean') base[k] = profile[k];
  }
  return base;
}

// Ad rules match by DESTINATION domain, not by resource type, so "stop
// blocking ads here" cannot be expressed as a type filter the way images and
// media can. These are the types ad rules realistically hit, deliberately
// EXCLUDING image and media so that turning ads back on for a site does not
// quietly also turn images and video back on — those stay under their own
// overrides.
const AD_RESOURCE_TYPES = [
  'script', 'xmlhttprequest', 'sub_frame', 'ping',
  'websocket', 'font', 'stylesheet', 'other'
];

const PROFILE_RESOURCE_TYPES = {
  ads: AD_RESOURCE_TYPES,
  images: ['image'],
  media: ['media']
};

// One allow rule per (site, category the site wants unblocked). initiatorDomains
// matches the page making the request and covers subdomains on its own.
function siteProfileRules(data, startId) {
  const rules = [];
  let id = startId;
  const profiles = data.siteProfiles || {};

  for (const domain of Object.keys(profiles)) {
    const profile = profiles[domain] || {};
    for (const key of PROFILE_KEYS) {
      // Only an explicit "false" (don't block this here) needs a rule. An
      // explicit "true" needs none — the static ruleset already blocks it.
      if (profile[key] !== false) continue;
      // Nothing to override if the category is globally off anyway.
      if (!data[key]) continue;
      rules.push({
        id: id++,
        priority: SITE_PROFILE_RULE_PRIORITY,
        action: { type: 'allow' },
        condition: {
          initiatorDomains: [domain],
          resourceTypes: PROFILE_RESOURCE_TYPES[key]
        }
      });
    }
  }
  return rules;
}

// Writing a profile from the popup or the dashboard. Passing an empty object
// (or one that matches the globals) removes the entry rather than storing a
// no-op, so the stored set stays a list of real exceptions.
function setSiteProfile(hostname, profile) {
  return chrome.storage.sync
    .get({ siteProfiles: {} })
    .then(({ siteProfiles }) => {
      const next = Object.assign({}, siteProfiles);
      // Edit the entry that already covers this host rather than adding a
      // narrower one that would never take effect — the same rule the
      // allowlist follows for subdomains.
      const key = profileEntryFor(hostname, siteProfiles) || hostname;

      const clean = {};
      for (const k of PROFILE_KEYS) {
        if (profile && typeof profile[k] === 'boolean') clean[k] = profile[k];
      }

      if (Object.keys(clean).length === 0) delete next[key];
      else next[key] = clean;

      return chrome.storage.sync.set({ siteProfiles: next }).then(() => clean);
    });
}

// ----------------------------
// 🪫 Data budget
// ----------------------------
// WHAT THIS IS NOT: a meter. The extension cannot measure data consumption
// and must never pretend to.
//   - stats.bytes is what we BLOCKED, inferred from AVG_BYTES, not what was used.
//   - Chrome exposes no production API for real byte counts (getMatchedRules
//     costs a permission warning and covers 5 minutes; onRuleMatchedDebug is
//     unpacked-only).
//   - Resource Timing reports transferSize 0 for cross-origin resources
//     without Timing-Allow-Origin, so any total built from it undercounts badly.
//   - The carrier's cap covers the whole DEVICE. We see one browser.
// So the UI never says "1.2 GB remaining". It says what it actually did.
//
// WHAT THIS IS: a pacing policy. The allowance sets where on the ladder the
// cycle starts; the calendar walks it up from there. Every input is something
// the user told us, and every output is something we control.
const BUDGET_STAGES = ['relaxed', 'normal', 'tight', 'strict'];

// Where a cycle starts, by allowance. A tiny plan begins cautious; a very
// large one begins relaxed and is capped below 'strict' further down.
function budgetBaseStage(budgetMB) {
  if (!budgetMB || budgetMB <= 0) return 1;      // unset — behave like a normal month
  if (budgetMB < 1024) return 2;                 // under 1 GB
  if (budgetMB < 5 * 1024) return 1;             // 1-5 GB
  return 0;                                      // 5 GB and up
}

// Billing cycles are anchored to a day of the month. Capped at 28 so the
// anchor exists in February and the cycle length never silently changes.
function cycleInfo(resetDay, now) {
  const day = Math.min(Math.max(parseInt(resetDay, 10) || 1, 1), 28);
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), day);
  if (d < start) start.setMonth(start.getMonth() - 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, day);

  const days = Math.round((end - start) / DAY_MS);
  const elapsed = (d - start) / DAY_MS;
  return {
    start: start.getTime(),
    days,
    dayIndex: Math.min(Math.floor(elapsed) + 1, days),
    fraction: Math.min(Math.max(elapsed / days, 0), 1)
  };
}

// Pure: the stage this cycle is on right now.
function budgetStage({ budgetMB, budgetResetDay, budgetEase, now }) {
  const cycle = cycleInfo(budgetResetDay, now);

  let index = budgetBaseStage(budgetMB);
  if (cycle.fraction >= 0.5) index += 1;
  if (cycle.fraction >= 0.8) index += 1;

  // A generous allowance never reaches the stage that trims the video
  // allowlist — at 20 GB the cap is not what is going to bite.
  const ceiling = (budgetMB && budgetMB >= 20 * 1024) ? 1 : BUDGET_STAGES.length - 1;
  index = Math.min(index, ceiling);

  // "Ease off" drops one stage for the REST OF THIS CYCLE only, so the choice
  // does not silently persist into a month the user never agreed to.
  if (budgetEase && budgetEase.cycleStart === cycle.start) index -= 1;

  index = Math.min(Math.max(index, 0), BUDGET_STAGES.length - 1);
  return { stage: BUDGET_STAGES[index], index, cycle };
}

// What each stage actually switches on. It can only ever ADD blocking —
// a budget that turned protection off would be a bug, not a feature.
function applyBudgetStage(data, stage) {
  const out = Object.assign({}, data);
  if (stage === 'relaxed') {
    out.ads = true;
  } else if (stage === 'normal') {
    out.ads = true;
    out.media = true;
  } else if (stage === 'tight' || stage === 'strict') {
    out.ads = true;
    out.images = true;
    out.media = true;
  }

  if (stage === 'strict') {
    // Drop the video platforms we shipped unblocked, but keep anything the
    // user explicitly chose (userChoices[x] === true) and every call site.
    // This is exactly the distinction userChoices was added to preserve.
    const choices = data.userChoices || {};
    out.allowlist = (data.allowlist || []).filter(
      (d) => choices[d] === true || CALL_SITES.includes(d)
    );
  }

  out.budgetStage = stage;
  return out;
}

// The stage advances with the calendar, so it has to be re-applied without
// the user touching anything. Rather than add an alarms permission for it,
// this rides on traffic the extension already sees: the counter reports
// blocked requests constantly while browsing, which is exactly when a stage
// change matters. One local read, and a reconcile only when it actually moved.
function ensureBudgetStage(now = Date.now()) {
  return chrome.storage.sync
    .get({ budgetEnabled: false, budgetMB: 0, budgetResetDay: 1, budgetEase: null })
    .then((cfg) => {
      if (!cfg.budgetEnabled) return null;
      const { stage } = budgetStage({
        budgetMB: cfg.budgetMB,
        budgetResetDay: cfg.budgetResetDay,
        budgetEase: cfg.budgetEase,
        now
      });
      return chrome.storage.local.get({ appliedBudgetStage: null }).then(({ appliedBudgetStage }) => {
        if (appliedBudgetStage === stage) return null;
        return chrome.storage.local
          .set({ appliedBudgetStage: stage })
          .then(() => { loadAndSetInitialState(); return stage; });
      });
    });
}

// "Ease off" steps the stage down for the rest of THIS cycle only. Stamped
// with the cycle start so it expires on its own at the next reset rather than
// quietly persisting into a month the user never agreed to.
function easeBudget(now = Date.now()) {
  return chrome.storage.sync
    .get({ budgetResetDay: 1 })
    .then(({ budgetResetDay }) => {
      const cycle = cycleInfo(budgetResetDay, now);
      return chrome.storage.sync.set({ budgetEase: { cycleStart: cycle.start } });
    });
}

// ----------------------------
// 📤 Export / import
// ----------------------------
// The same shape an administrator would push through managed storage, so a
// configuration worked out by hand on one machine can be handed to a fleet
// without being retyped.
const POLICY_VERSION = 1;

function exportPolicy() {
  return chrome.storage.sync.get(SETTING_DEFAULTS).then((data) => ({
    version: POLICY_VERSION,
    exportedAt: new Date().toISOString(),
    ads: data.ads,
    images: data.images,
    media: data.media,
    autoMode: data.autoMode,
    consent: data.consent,
    popups: data.popups,
    allowlist: data.allowlist,
    siteProfiles: data.siteProfiles
  }));
}

// Imported JSON is untrusted input — a file the user was handed. Every field
// is checked and anything unrecognised is dropped rather than merged, so a
// malformed or hostile file cannot write arbitrary keys into storage.
function sanitisePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('not an object');
  if (policy.version != null && policy.version !== POLICY_VERSION) {
    throw new Error(`unsupported version ${policy.version}`);
  }

  const out = {};
  for (const k of ['ads', 'images', 'media', 'autoMode', 'consent', 'popups']) {
    if (typeof policy[k] === 'boolean') out[k] = policy[k];
  }

  if (Array.isArray(policy.allowlist)) {
    out.allowlist = policy.allowlist
      .filter((d) => typeof d === 'string')
      .map((d) => d.trim().toLowerCase())
      // A bare hostname only. Anything with a scheme, path, space or wildcard
      // would not match the way allowlistEntryFor expects and is discarded.
      .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  }

  if (policy.siteProfiles && typeof policy.siteProfiles === 'object' && !Array.isArray(policy.siteProfiles)) {
    const profiles = {};
    for (const [domain, profile] of Object.entries(policy.siteProfiles)) {
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(String(domain).toLowerCase())) continue;
      if (!profile || typeof profile !== 'object') continue;
      const clean = {};
      for (const k of PROFILE_KEYS) {
        if (typeof profile[k] === 'boolean') clean[k] = profile[k];
      }
      if (Object.keys(clean).length) profiles[String(domain).toLowerCase()] = clean;
    }
    out.siteProfiles = profiles;
  }

  if (Object.keys(out).length === 0) throw new Error('nothing recognisable to import');
  return out;
}

// async, not a plain function that throws: the message handler chains
// .then().catch() onto this, and a SYNCHRONOUS throw would skip the catch
// entirely — so sendResponse would never fire and the dashboard would sit
// waiting for a reply that never comes. Same rule as the toggle handler.
async function importPolicy(policy) {
  const clean = sanitisePolicy(policy);
  await chrome.storage.sync.set(clean);
  return Object.keys(clean);
}

// Sites whose profile switches a category OFF also need the matching content
// script to skip them — the DNR rule stops the request, but the DOM-level
// scripts would still hide or stop what did load.
function profileExclusions(data, key) {
  const profiles = data.siteProfiles || {};
  return Object.keys(profiles).filter((d) => (profiles[d] || {})[key] === false);
}

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

// Never trimmed, whatever the data budget says. Dropping a meeting to save a
// few megabytes is not a trade anyone wants made on their behalf.
const CALL_SITES = ['meet.google.com', 'zoom.us', 'teams.microsoft.com', 'whereby.com'];

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

// Every dynamic rule the extension owns is rebuilt in one call. Allowlist and
// profile rules used to be able to collide on ids if they were written
// separately; generating both from one counter makes that impossible.
function syncDynamicRules(data) {
  const allowlist = data.allowlist || [];
  chrome.declarativeNetRequest.getDynamicRules((existingRules) => {
    const removeRuleIds = (existingRules || []).map((r) => r.id);

    const addRules = allowlist.map((domain, i) => ({
      id: i + 1,
      priority: ALLOWLIST_RULE_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: {
        urlFilter: `||${domain}^`,
        resourceTypes: ['main_frame']
      }
    }));

    // Profile rules sit below a full pause but above every static block rule,
    // so a paused site still wins over its own profile.
    for (const rule of siteProfileRules(data, addRules.length + 1)) addRules.push(rule);

    chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules }, () => {
      if (chrome.runtime.lastError) {
        console.warn('⚠️ Error syncing dynamic rules:', chrome.runtime.lastError.message);
        return;
      }
      console.log(`🟢 Dynamic rules synced: ${allowlist.length} paused, ${addRules.length - allowlist.length} profile`);
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

function updateContentScript(key, isEnabled, excluded) {
  registerScripts(CONTENT_SCRIPTS[key], isEnabled, excluded);
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
  const { ads, images, media } = data;
  const allowlist = data.allowlist || [];

  applyRulesetState(ads, images, media);

  // A site whose profile turns a category off has to be skipped by that
  // category's content script too: the DNR rule stops the request, but the
  // DOM-level script would still hide or stop whatever did load.
  updateContentScript('media', media, allowlist.concat(profileExclusions(data, 'media')));
  updateContentScript('images', images, allowlist.concat(profileExclusions(data, 'images')));

  registerScripts([COUNTER_SCRIPT], ads || images || media, allowlist);
  registerScripts([CONSENT_SCRIPT], Boolean(data.consent) && isPro(), allowlist);
  registerScripts([POPUP_SCRIPT], Boolean(data.popups) && isPro(), allowlist);

  syncDynamicRules(data);
}

// Managed policy and auto-mode are layered on top of what the user chose, in
// that order, and the result is what everything downstream sees. Pure so the
// precedence can be tested without a browser.
function mergeSettings(user, managed, autoState, now = Date.now()) {
  let out = Object.assign({}, user);

  // 1. The data budget sets the baseline for this point in the cycle. It can
  //    only add blocking, never remove it.
  if (out.budgetEnabled) {
    const { stage, cycle } = budgetStage({
      budgetMB: out.budgetMB,
      budgetResetDay: out.budgetResetDay,
      budgetEase: out.budgetEase,
      now
    });
    out = applyBudgetStage(out, stage);
    out.budgetCycle = cycle;
  }

  // 2. An administrator's policy wins over the user AND over the budget. Only
  //    keys the policy actually sets are applied — a partial policy leaves the
  //    rest alone.
  const policy = managed || {};
  for (const k of ['ads', 'images', 'media', 'consent', 'popups']) {
    if (typeof policy[k] === 'boolean') out[k] = policy[k];
  }
  if (Array.isArray(policy.allowlist)) out.allowlist = policy.allowlist;
  if (policy.siteProfiles && typeof policy.siteProfiles === 'object') out.siteProfiles = policy.siteProfiles;
  out.managedKeys = Object.keys(policy);

  // 3. Auto-mode relaxes exactly one thing — image blocking on a connection
  //    that is not short of bandwidth — and it deliberately outranks the
  //    budget. A fast connection almost certainly is not the metered link, so
  //    tightening there costs page quality for no saving. It still cannot
  //    touch ads or video, and it never overrides an enforced policy.
  if (out.autoMode && autoState && autoState.fast && !policy.images) {
    out.images = false;
    out.autoRelaxed = true;
  }

  return out;
}

const SETTING_DEFAULTS = {
  ads: true, images: true, media: true,
  allowlist: [], siteProfiles: {},
  autoMode: false, consent: false, popups: false, siteHistory: false,
  budgetEnabled: false, budgetMB: 0, budgetResetDay: 1, budgetEase: null
};

function readManagedPolicy() {
  return new Promise((resolve) => {
    // storage.managed throws rather than resolving empty when no policy is
    // installed, which is the normal case for every consumer install.
    if (!chrome.storage.managed) { resolve({}); return; }
    chrome.storage.managed.get(null, (policy) => {
      void chrome.runtime.lastError;
      resolve(policy || {});
    });
  });
}

function loadAndSetInitialState() {
  chrome.storage.sync.get(SETTING_DEFAULTS, (user) => {
    chrome.storage.local.get({ autoState: null }, ({ autoState }) => {
      readManagedPolicy().then((managed) => {
        refreshAll(mergeSettings(user, managed, autoState));
      });
    });
  });
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

  // The review prompt waits on "installed >= 15 days", which needs a date to
  // count from. stats.since is stamped on the first blocked request rather
  // than at install, and an upgrading user has no install date at all, so
  // stamp one here. Written only when absent: re-stamping on every update
  // would push the prompt out forever for the users most entitled to it.
  chrome.storage.local.get({ installedAt: null }, ({ installedAt }) => {
    if (!installedAt) chrome.storage.local.set({ installedAt: Date.now() });
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
  ids.push(COUNTER_SCRIPT.id, CONSENT_SCRIPT.id, POPUP_SCRIPT.id);
  chrome.scripting.unregisterContentScripts({ ids }, () => {
    void chrome.runtime.lastError;
    loadAndSetInitialState();
    refreshAllBadges();
    // A cycle may have rolled over while the browser was closed.
    ensureBudgetStage().catch((e) => console.warn('⚠️ Could not re-check the data budget:', e));
  });
});

// ----------------------------
// 🧠 React to Settings Changes (single source of truth)
// ----------------------------
const RECONCILE_KEYS = [
  'ads', 'images', 'media', 'allowlist', 'siteProfiles', 'autoMode', 'consent', 'popups',
  'budgetEnabled', 'budgetMB', 'budgetResetDay', 'budgetEase'
];

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && RECONCILE_KEYS.some((k) => changes[k])) {
    loadAndSetInitialState();
  }
  // Turning site history off has to delete what it already gathered —
  // leaving the old list behind would make the switch a promise about the
  // future only. Handled here rather than in the dashboard so it happens
  // however the setting was changed, including a sync from another device.
  if (areaName === 'sync' && changes.siteHistory && changes.siteHistory.newValue === false) {
    chrome.storage.local.set({ siteStats: {} });
  }

  // Auto-mode lives in local storage because it is an observation, not a
  // preference, and syncing it across devices would be wrong.
  if (areaName === 'local' && changes.autoState) {
    loadAndSetInitialState();
  }
  // The allowlist can change from the popup, the keyboard shortcut, or a sync
  // from another device — repaint every tab's badge rather than just the one.
  if (areaName === 'sync' && changes.allowlist) refreshAllBadges();
});
