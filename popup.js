// popup.js

// ----------------------------
// 🌍 Localisation
// ----------------------------
// Chrome Web Store search is per-locale, and the extension's own market is
// overwhelmingly non-English (India alone is ~24% of installs), so the UI is
// driven from _locales rather than hardcoded. The English text stays in the
// HTML as the fallback: if a key is ever missing, chrome.i18n returns an empty
// string, and replacing good text with nothing would be worse than not
// translating it at all.
function applyTranslations(root) {
  const nodes = (root || document).querySelectorAll('[data-i18n]');
  for (const el of nodes) {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  }
}

function t(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.length ? subs : undefined);
}

document.addEventListener('DOMContentLoaded', () => {
  // Arabic and Persian together are ~10% of installs (Egypt 5.1%, Iran 5.1%),
  // so the layout has to mirror rather than just swap the words. @@bidi_dir is
  // supplied by Chrome from the active locale.
  const dir = chrome.i18n.getMessage('@@bidi_dir');
  if (dir === 'rtl') document.body.setAttribute('dir', 'rtl');

  applyTranslations();
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
  initSavings();
});

// ----------------------------
// 📊 Savings meter
// ----------------------------
// One decimal place only while it carries information — "644.0 MB" is noise,
// "6.4 MB" is not.
function scale(n) {
  return n >= 100 ? Math.round(n).toString() : n.toFixed(1);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return [scale(bytes / (1024 * 1024 * 1024)), 'GB'];
  if (bytes >= 1024 * 1024) return [scale(bytes / (1024 * 1024)), 'MB'];
  if (bytes >= 1024) return [Math.round(bytes / 1024).toString(), 'KB'];
  return [bytes.toString(), 'B'];
}

function formatCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : n.toString();
}

function renderSavings(stats) {
  const amount = document.getElementById('savedAmount');
  const unit = document.getElementById('savedUnit');
  const label = document.getElementById('savedLabel');
  const since = document.getElementById('savedSince');

  const total = (stats.ads || 0) + (stats.images || 0) + (stats.media || 0);

  document.getElementById('statAds').textContent = formatCount(stats.ads || 0);
  document.getElementById('statImages').textContent = formatCount(stats.images || 0);
  document.getElementById('statMedia').textContent = formatCount(stats.media || 0);

  if (!total) {
    // Nothing counted yet. Hide the number entirely rather than showing a
    // confident "0 MB" (reads as broken) or a placeholder dash (reads as a
    // rendering glitch) — the label carries the whole message instead.
    document.getElementById('savedTop').hidden = true;
    label.textContent = t('savingsEmpty') || 'Browse a little and your savings will show up here';
    since.textContent = t('savingsEstimated') || 'Estimated from blocked requests';
    return;
  }

  document.getElementById('savedTop').hidden = false;

  // The COUNT leads, not the byte figure. The count is exact; the bytes are an
  // estimate from AVG_BYTES, so putting the precise number first is both the
  // more impressive figure and the more honest one.
  amount.textContent = total.toLocaleString();
  unit.textContent = t('savingsRequests') || 'requests blocked';

  const [value, suffix] = formatBytes(stats.bytes || 0);
  label.textContent = t('savingsBytes', `${value} ${suffix}`) || `≈ ${value} ${suffix} saved`;

  if (stats.since) {
    const date = new Date(stats.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    since.textContent = t('savingsEstimatedSince', date) || `Estimated, since ${date}`;
  } else {
    since.textContent = t('savingsEstimated') || 'Estimated from blocked requests';
  }
}

function initSavings() {
  const EMPTY = { ads: 0, images: 0, media: 0, bytes: 0, since: null };

  chrome.storage.local.get({ stats: EMPTY }, ({ stats }) => renderSavings(stats));

  // The popup can be open while pages in other tabs keep blocking, so keep it live.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.stats) renderSavings(changes.stats.newValue || EMPTY);
  });

  document.getElementById('resetStats').addEventListener('click', () => {
    chrome.storage.local.set({ stats: { ...EMPTY, since: Date.now() } }, () => {
      renderSavings({ ...EMPTY, since: Date.now() });
    });
  });
}

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
  const hint = document.querySelector('.shortcut-hint');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const hostname = tab && tab.url ? getHostname(tab.url) : null;

    if (!hostname) {
      siteHost.textContent = t('siteNoHost') || 'No site on this page';
      siteStatus.textContent = t('siteNothingToDo') || 'Nothing to unblock here';
      siteToggleBtn.disabled = true;
      if (hint) hint.hidden = true;
      return;
    }

    siteHost.textContent = hostname;

    // background.js owns subdomain-aware matching — asking it keeps the popup
    // from disagreeing with the rules on e.g. www.youtube.com vs youtube.com.
    chrome.runtime.sendMessage({ type: 'ds-site-state', hostname }, (res) => {
      void chrome.runtime.lastError;
      render(Boolean(res && res.paused));
    });

    function render(isPaused) {
      siteStatus.textContent = isPaused
        ? (t('siteNotBlocking') || 'Not blocking on this site')
        : (t('siteBlocking') || 'Blocking active');
      siteStatus.classList.toggle('paused', isPaused);
      // Say what the button DOES, not what the state is.
      siteToggleBtn.textContent = isPaused
        ? (t('siteResume') || 'Resume blocking here')
        : (t('siteDontBlock') || "Don't block on this site");
      siteToggleBtn.classList.toggle('is-paused', isPaused);

      siteToggleBtn.onclick = () => {
        siteToggleBtn.disabled = true;
        // background.js owns the allowlist so the popup and the keyboard
        // shortcut can't drift apart.
        chrome.runtime.sendMessage({ type: 'ds-toggle-site', hostname }, () => {
          void chrome.runtime.lastError;
          // Rules and content scripts only apply to future requests, so the
          // page needs a reload to actually reflect the change.
          if (tab.id != null) chrome.tabs.reload(tab.id);
          window.close();
        });
      };
    }
  });
}
