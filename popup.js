// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const adsToggle = document.getElementById('adsToggle');
  const imagesToggle = document.getElementById('imagesToggle');
  const mediaToggle = document.getElementById('mediaToggle');
  const saveBtn = document.getElementById('saveBtn');

  // Load current settings from Chrome storage
  // Note: The nullish coalescing operator (??) ensures they default to 'true' 
  // if no data is found, which corresponds to the toggles being 'ON' by default.
  chrome.storage.sync.get(['ads', 'images', 'media'], (data) => {
    adsToggle.checked = data.ads ?? true;
    imagesToggle.checked = data.images ?? true;
    mediaToggle.checked = data.media ?? true;
  });

  // Event listener for the Save button
  saveBtn.addEventListener('click', () => {
    // 1. Collect the current settings from the toggles
    const settings = {
      ads: adsToggle.checked,
      images: imagesToggle.checked,
      media: mediaToggle.checked
    };

    // 2. Save the settings to Chrome storage
    chrome.storage.sync.set(settings, () => {
      // 3. Update Declarative Net Request (DNR) rulesets
      const enableIds = [];
      const disableIds = [];
      
      // Determine which rulesets to enable (checked/true) and disable (unchecked/false)
      if (settings.ads) enableIds.push('ads'); else disableIds.push('ads');
      if (settings.images) enableIds.push('images'); else disableIds.push('images');
      if (settings.media) enableIds.push('media'); else disableIds.push('media');

      chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enableIds,
        disableRulesetIds: disableIds
      }, () => {
        console.log('✅ Updated DNR rules:', enableIds);
        
        // 4. Automatically close the popup window after saving and updating rules
        // This addresses the final requirement.
        window.close();
      });
    });
  });
});