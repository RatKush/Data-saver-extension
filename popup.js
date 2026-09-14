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
  initReview();

  document.getElementById('openDashboard').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
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
    renderBar(stats, 0);
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

  renderBar(stats, total);
}

// The three counts are parts of one total, so they are drawn as one bar in a
// single hue rather than three competing colours. Each segment is also direct-
// labelled underneath, so the split never rests on colour alone.
function renderBar(stats, total) {
  const segments = [
    ['barAds', stats.ads || 0],
    ['barImages', stats.images || 0],
    ['barMedia', stats.media || 0],
  ];

  for (const [id, value] of segments) {
    const el = document.getElementById(id);
    if (!el) continue;
    // A category with a real count always gets a visible sliver rather than a
    // sub-pixel one, so "some videos were blocked" never renders as nothing.
    const pct = total > 0 && value > 0 ? Math.max((value / total) * 100, 3) : 0;
    el.style.width = `${pct}%`;
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

const PILL_LABEL = { ads: 'savingsAds', images: 'savingsImages', media: 'savingsVideos' };

// Mirrors profileEntryFor in background.js: longest match wins, so a rule on
// news.example.com beats one on example.com. The popup only reads with this —
// every write goes through background.js, which owns the canonical version.
function coveringProfile(hostname, siteProfiles) {
  let best = null;
  for (const d of Object.keys(siteProfiles || {})) {
    if (hostname === d || hostname.endsWith('.' + d)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
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

    // The three pills show what happens ON THIS SITE. They are hidden while the
    // whole site is paused, because a per-category rule cannot mean anything
    // when nothing is being blocked here at all.
    function renderPills(isPaused) {
      const box = document.getElementById('siteOnly');
      if (!box) return;
      if (isPaused) { box.hidden = true; return; }

      chrome.storage.sync.get(
        { ads: true, images: true, media: true, siteProfiles: {} },
        (data) => {
          const key = coveringProfile(hostname, data.siteProfiles);
          const profile = (key && data.siteProfiles[key]) || {};
          box.hidden = false;

          for (const el of box.querySelectorAll('.pill')) {
            const k = el.dataset.key;
            const isOverride = typeof profile[k] === 'boolean';
            const blocking = isOverride ? profile[k] : data[k];

            el.textContent = t(PILL_LABEL[k]) || el.dataset.key;
            el.classList.toggle('on', blocking);
            el.classList.toggle('override', isOverride);
            el.title = blocking
              ? (t('pillBlocking') || 'Blocking here — click to allow on this site')
              : (t('pillAllowing') || 'Allowed here — click to block on this site');

            el.onclick = () => {
              const next = Object.assign({}, profile);
              const flipped = !blocking;
              // Back in line with the global switch? Drop the override rather
              // than storing a rule that says the same thing.
              if (flipped === data[k]) delete next[k];
              else next[k] = flipped;

              for (const p of box.querySelectorAll('.pill')) p.disabled = true;
              chrome.runtime.sendMessage(
                { type: 'ds-site-profile', hostname, profile: next },
                () => {
                  void chrome.runtime.lastError;
                  // Rules only apply to future requests, so the page has to
                  // reload for this to be visible — same as pausing a site.
                  if (tab.id != null) chrome.tabs.reload(tab.id);
                  window.close();
                }
              );
            };
          }
        }
      );
    }

    function render(isPaused) {
      renderPills(isPaused);
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

// ----------------------------
// ⭐ Review prompt
// ----------------------------
// Shown in the popup rather than injected into the page. That means it only
// appears when the user has deliberately opened the panel to look at their own
// savings — the least intrusive moment available, and the one where the number
// the prompt refers to is already on screen.
//
// background.js owns the decision (shouldAskForReview) for the same reason it
// owns toggleSite: one implementation, and it is the half that can be tested
// without a browser. The popup only renders the answer.
function initReview() {
  const card = document.getElementById('reviewCard');
  const body = document.getElementById('reviewBody');
  const rate = document.getElementById('reviewRate');
  const later = document.getElementById('reviewLater');
  if (!card || !rate || !later) return;

  chrome.runtime.sendMessage({ type: 'ds-review-state' }, (res) => {
    void chrome.runtime.lastError;
    if (!res || !res.show) return; // stays hidden, which is the resting state

    if (body && res.total) {
      const msg = t('reviewBody', res.total.toLocaleString());
      if (msg) body.textContent = msg;
    }
    card.hidden = false;
  });

  function close(action) {
    card.hidden = true;
    chrome.runtime.sendMessage({ type: 'ds-review-action', action }, () => {
      void chrome.runtime.lastError;
    });
  }

  rate.addEventListener('click', () => {
    // runtime.id rather than a hardcoded extension id, so this still points
    // somewhere sane when the extension is loaded unpacked for testing.
    chrome.tabs.create({
      url: `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`
    });
    close('rated');
    window.close();
  });

  later.addEventListener('click', () => close('later'));
}
