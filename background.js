// Define the unique ID for the content script
const MEDIA_SCRIPT_ID = 'data-saver-media-blocker';
const mediaContentScript = {
  id: MEDIA_SCRIPT_ID,
  matches: ["<all_urls>"],
  js: ["stop_all_videos.js"],
  run_at: "document_start",
  all_frames: true
};

// --- DNR Rules Management (Your existing function) ---
function enableRules() {
  // NOTE: When using the popup, the ruleset states are controlled there.
  // This function ensures all rulesets are 'available' to be toggled.
  // We should fetch the user's settings to set the correct initial state.
  chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: ["ads", "images", "media"] // Enables all if they were disabled externally
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn("⚠️ Error enabling rules:", chrome.runtime.lastError.message);
    } else {
      console.log("✅ Data Saver rulesets ensured active");
      // Now, load the actual state from storage and update DNR based on that.
      loadAndSetInitialState();
    }
  });
}

// --- Content Script Management ---
function updateContentScript(isMediaBlocked) {
  if (isMediaBlocked) {
    // Media blocking is ON: Register and run the content script
    chrome.scripting.getRegisteredContentScripts({ ids: [MEDIA_SCRIPT_ID] }, (scripts) => {
      if (scripts.length === 0) {
        chrome.scripting.registerContentScripts([mediaContentScript], () => {
          console.log("✅ stop_all_videos.js registered.");
        });
      }
    });
  } else {
    // Media blocking is OFF: Unregister the content script
    chrome.scripting.unregisterContentScripts({ ids: [MEDIA_SCRIPT_ID] }, () => {
      console.log("❌ stop_all_videos.js unregistered.");
    });
  }
}

// --- Initial State Load and Application ---
function loadAndSetInitialState() {
  chrome.storage.sync.get(['ads', 'images', 'media'], (data) => {
    // The popup defaults to true, so we use true if the key is missing
    const isMediaBlocked = data.media ?? true;
    
    // 1. Update DNR rules based on all settings (though the popup does this too, good for startup)
    const enableIds = [];
    const disableIds = [];
    if (data.ads ?? true) enableIds.push('ads'); else disableIds.push('ads');
    if (data.images ?? true) enableIds.push('images'); else disableIds.push('images');
    if (data.media ?? true) enableIds.push('media'); else disableIds.push('media');

    chrome.declarativeNetRequest.updateEnabledRulesets({
      enableRulesetIds: enableIds,
      disableRulesetIds: disableIds
    }, () => {
      console.log('🔄 Initial DNR state set:', enableIds);
      
      // 2. Control the content script based on the media setting
      updateContentScript(isMediaBlocked);
    });
  });
}

// --- Event Listeners ---

// Trigger when installed or browser starts
chrome.runtime.onInstalled.addListener(() => {
  console.log("🚀 Data Saver Extension installed");
  enableRules(); // Ensures DNR rules are set up and then loads the state
});

chrome.runtime.onStartup.addListener(() => {
  console.log("🔁 Browser restarted — ensuring rules are active");
  enableRules(); // Ensures DNR rules are set up and then loads the state
});

// Listen for changes from the popup
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.media) {
    // The popup already handled DNR for media, now we handle the content script
    updateContentScript(changes.media.newValue);
  }
  // No need to check for ads/images as they only use DNR, which the popup handles.
});