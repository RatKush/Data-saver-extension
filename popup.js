// popup.js

document.addEventListener('DOMContentLoaded', () => {
  const adsToggle = document.getElementById('adsToggle');
  const imagesToggle = document.getElementById('imagesToggle');
  const mediaToggle = document.getElementById('mediaToggle');
  const savedFlash = document.getElementById('savedFlash');

  // Load current settings from Chrome storage. The nullish coalescing
  // operator (??) defaults toggles to 'on' if no data is found yet.
  chrome.storage.sync.get(['ads', 'images', 'media'], (data) => {
    adsToggle.checked = data.ads ?? true;
    imagesToggle.checked = data.images ?? true;
    mediaToggle.checked = data.media ?? true;
  });

  // Instant-apply: each toggle writes to storage the moment it changes.
  // background.js listens for storage changes and is the single source
  // of truth for applying DNR ruleset + content script updates, so
  // there's nothing else to do here beyond persisting the value and
  // giving a small confirmation that it took.
  let flashTimer = null;
  function flashSaved() {
    savedFlash.classList.add('visible');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => savedFlash.classList.remove('visible'), 1200);
  }

  for (const [toggle, key] of [
    [adsToggle, 'ads'],
    [imagesToggle, 'images'],
    [mediaToggle, 'media'],
  ]) {
    toggle.addEventListener('change', () => {
      chrome.storage.sync.set({ [key]: toggle.checked }, flashSaved);
    });
  }

  initSiteToggle();
});

// ----------------------------
// 🌐 Per-site pause
// ----------------------------
function getHostname(url) {
  try {
    return new URL(url).hostname || null;
  } catch (e) {
    return null; // chrome://, about:, file:// without a real host, etc.
  }
}

function initSiteToggle() {
  const siteHost = document.getElementById('siteHost');
  const siteStatus = document.getElementById('siteStatus');
  const siteToggleBtn = document.getElementById('siteToggleBtn');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const hostname = tab && tab.url ? getHostname(tab.url) : null;

    if (!hostname) {
      siteHost.textContent = 'No site on this page';
      siteStatus.textContent = 'Nothing to pause here';
      siteToggleBtn.disabled = true;
      return;
    }

    siteHost.textContent = hostname;

    chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
      renderSiteToggle(hostname, allowlist.includes(hostname));
    });

    function renderSiteToggle(host, isPaused) {
      siteStatus.textContent = isPaused ? 'Blocking paused here' : 'Blocking active';
      siteStatus.classList.toggle('paused', isPaused);
      siteToggleBtn.textContent = isPaused ? 'Resume' : 'Pause';
      siteToggleBtn.classList.toggle('is-paused', isPaused);

      siteToggleBtn.onclick = () => {
        chrome.storage.sync.get({ allowlist: [] }, ({ allowlist }) => {
          const next = isPaused
            ? allowlist.filter((d) => d !== host)
            : [...allowlist, host];

          chrome.storage.sync.set({ allowlist: next }, () => {
            // Rules/content-scripts only apply to future requests, so the
            // current page needs a reload to actually reflect the change.
            if (tab.id != null) chrome.tabs.reload(tab.id);
            window.close();
          });
        });
      };
    }
  });
}
