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

// Reserved id range for the per-site "pause on this site" dynamic rules
// (see syncAllowlistDynamicRules), kept distinct from anything else that
// might one day also use chrome.declarativeNetRequest.updateDynamicRules.
const ALLOWLIST_RULE_PRIORITY = 1000; // above every static block rule

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
function updateContentScript(key, isEnabled, allowlist) {
  const excludeMatches = allowlistMatchPatterns(allowlist);
  const scripts = CONTENT_SCRIPTS[key].map((s) => ({ ...s, excludeMatches }));
  const ids = scripts.map((s) => s.id);

  // Always unregister first, then re-register if enabled. That's the
  // simplest way to guarantee excludeMatches is up to date whenever the
  // allowlist changes, not just when the feature toggle itself changes.
  chrome.scripting.unregisterContentScripts({ ids }, () => {
    void chrome.runtime.lastError; // ignore "not currently registered" on first run
    if (!isEnabled) return;
    chrome.scripting.registerContentScripts(scripts, () => {
      if (chrome.runtime.lastError) {
        console.warn(`⚠️ registerContentScripts (${key}) error:`, chrome.runtime.lastError.message);
      } else {
        console.log(`✅ ${key} scripts registered (excluding ${allowlist.length} paused site(s))`);
      }
    });
  });
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
  syncAllowlistDynamicRules(allowlist);
}

function loadAndSetInitialState() {
  chrome.storage.sync.get({ ads: true, images: true, media: true, allowlist: [] }, refreshAll);
}

// ----------------------------
// 🚀 Event Listeners
// ----------------------------
chrome.runtime.onInstalled.addListener(() => {
  console.log('🚀 Data Saver Extension installed');
  loadAndSetInitialState();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('🔁 Browser restarted — ensuring clean rules & scripts');
  // Clean stale scripts before re-registering
  const ids = Object.values(CONTENT_SCRIPTS).flat().map((s) => s.id);
  chrome.scripting.unregisterContentScripts({ ids }, () => {
    loadAndSetInitialState();
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
});
