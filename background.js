// ----------------------------
// 🧩 Data Saver Background Script
// ----------------------------

// --- Unique ID for media content script ---
const MEDIA_SCRIPT_ID = 'data-saver-media-blocker';

const mediaContentScript = {
  id: MEDIA_SCRIPT_ID,
  matches: ['<all_urls>'],
  js: ['stop_all_videos.js'],
  runAt: 'document_start',
  allFrames: true
};

// ----------------------------
// ⚙️ DNR Rules Management
// ----------------------------
function enableRules() {
  chrome.declarativeNetRequest.updateEnabledRulesets(
    { enableRulesetIds: ['ads', 'images', 'media'] },
    () => {
      if (chrome.runtime.lastError) {
        console.warn('⚠️ Error enabling rules:', chrome.runtime.lastError.message);
        return;
      }
      console.log('✅ Data Saver rulesets ensured active');

      // Delay ensures async completion before loading stored state
      setTimeout(loadAndSetInitialState, 50);
    }
  );
}

// ----------------------------
// 🎬 Content Script Management
// ----------------------------
function updateContentScript(isMediaBlocked) {
  if (isMediaBlocked) {
    // --- Media blocking ON ---
    chrome.scripting.getRegisteredContentScripts({ ids: [MEDIA_SCRIPT_ID] }, (scripts) => {
      if (scripts.length === 0) {
        chrome.scripting.registerContentScripts([mediaContentScript], () => {
          if (chrome.runtime.lastError) {
            console.warn('⚠️ registerContentScripts error:', chrome.runtime.lastError.message);
          } else {
            console.log('✅ stop_all_videos.js registered.');
          }
        });
      } else {
        console.log('ℹ️ stop_all_videos.js already registered.');
      }
    });
  } else {
    // --- Media blocking OFF ---
    chrome.scripting.unregisterContentScripts({ ids: [MEDIA_SCRIPT_ID] }, () => {
      if (chrome.runtime.lastError) {
        console.warn('⚠️ unregisterContentScripts error:', chrome.runtime.lastError.message);
      } else {
        console.log('❌ stop_all_videos.js unregistered.');
      }
    });
  }
}

// ----------------------------
// 🔄 Initial State Load & Application
// ----------------------------
function loadAndSetInitialState() {
  chrome.storage.sync.get({ ads: true, images: true, media: true }, (data) => {
    const { ads, images, media } = data;

    const enableIds = [];
    const disableIds = [];

    if (ads) enableIds.push('ads'); else disableIds.push('ads');
    if (images) enableIds.push('images'); else disableIds.push('images');
    if (media) enableIds.push('media'); else disableIds.push('media');

    chrome.declarativeNetRequest.updateEnabledRulesets(
      {
        enableRulesetIds: enableIds,
        disableRulesetIds: disableIds
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('⚠️ Error updating initial DNR state:', chrome.runtime.lastError.message);
          return;
        }
        console.log('🔄 Initial DNR state set:', enableIds);
        updateContentScript(media);
      }
    );
  });
}

// ----------------------------
// 🚀 Event Listeners
// ----------------------------
chrome.runtime.onInstalled.addListener(() => {
  console.log('🚀 Data Saver Extension installed');
  enableRules();
});

chrome.runtime.onStartup.addListener(() => {
  console.log('🔁 Browser restarted — ensuring clean rules & scripts');
  // Clean stale scripts before re-registering
  chrome.scripting.unregisterContentScripts({ ids: [MEDIA_SCRIPT_ID] }, () => {
    enableRules();
  });
});

// ----------------------------
// 🧠 React to Settings Changes
// ----------------------------
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && changes.media) {
    console.log(`🎬 Media blocking toggled: ${changes.media.newValue ? 'ON' : 'OFF'}`);
    updateContentScript(changes.media.newValue);
  }
  // Ads/images DNR toggling handled by popup.js
});
