// dashboard.js — the options page: history, per-site rules, premium switches,
// and export/import. Everything it reads is local to this device.

function applyTranslations(root) {
  for (const el of (root || document).querySelectorAll('[data-i18n]')) {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    // Missing key returns '' — keep the English in the HTML rather than
    // replacing good text with nothing.
    if (msg) el.textContent = msg;
  }
}

const t = (key, ...subs) => chrome.i18n.getMessage(key, subs.length ? subs : undefined);
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function dayTotal(day) {
  if (!day) return 0;
  return (day.ads || 0) + (day.images || 0) + (day.media || 0);
}

function fmt(n) {
  return (n || 0).toLocaleString();
}

function shortDate(ts) {
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------
function renderHistory(history, stats) {
  const now = Date.now();
  const days = [];
  for (let i = 13; i >= 0; i--) {
    const ts = now - i * DAY_MS;
    days.push({ ts, total: dayTotal(history[dayKey(ts)]) });
  }

  const sum = (n) => {
    let out = 0;
    for (let i = 0; i < n; i++) out += dayTotal(history[dayKey(now - i * DAY_MS)]);
    return out;
  };

  document.getElementById('t7').textContent = fmt(sum(7));
  document.getElementById('t30').textContent = fmt(sum(30));
  document.getElementById('tAll').textContent =
    fmt((stats.ads || 0) + (stats.images || 0) + (stats.media || 0));

  const trend = document.getElementById('trend');
  trend.textContent = '';
  const peak = Math.max(1, ...days.map((d) => d.total));

  for (const day of days) {
    const bar = document.createElement('div');
    // Scale to the tallest day rather than to a fixed ceiling, so a quiet
    // fortnight still shows shape instead of a flat line.
    bar.style.height = `${Math.max((day.total / peak) * 100, 2)}%`;
    bar.title = `${shortDate(day.ts)} — ${fmt(day.total)}`;
    if (!day.total) bar.style.opacity = '0.25';
    trend.appendChild(bar);
  }

  document.getElementById('trendFrom').textContent = shortDate(days[0].ts);
  document.getElementById('trendTo').textContent = shortDate(days[days.length - 1].ts);
  document.getElementById('historyEmpty').hidden = days.some((d) => d.total > 0);
}

// ---------------------------------------------------------------------------
// Top sites
// ---------------------------------------------------------------------------
function renderTopSites(siteStats) {
  const box = document.getElementById('topSites');
  box.textContent = '';

  const rows = Object.entries(siteStats)
    .map(([host, v]) => ({ host, n: v.n || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  if (!rows.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = t('dashTopSitesEmpty') || 'Nothing recorded yet.';
    box.appendChild(p);
    return;
  }

  const peak = rows[0].n;
  for (const row of rows) {
    const el = document.createElement('div');
    el.className = 'site-row';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'site-name';
    name.textContent = row.host;
    const bar = document.createElement('div');
    bar.className = 'site-bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max((row.n / peak) * 100, 2)}%`;
    bar.appendChild(fill);
    left.append(name, bar);

    const n = document.createElement('div');
    n.className = 'site-n';
    n.textContent = fmt(row.n);

    el.append(left, n);
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Per-site rules
// ---------------------------------------------------------------------------
const LABELS = {
  ads: () => t('savingsAds') || 'ads',
  images: () => t('savingsImages') || 'images',
  media: () => t('savingsVideos') || 'videos'
};

function renderProfiles(siteProfiles) {
  const box = document.getElementById('profiles');
  box.textContent = '';

  const hosts = Object.keys(siteProfiles).sort();
  if (!hosts.length) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = t('dashProfilesEmpty')
      || 'No per-site rules yet. Open the popup on any site to add one.';
    box.appendChild(p);
    return;
  }

  for (const host of hosts) {
    const profile = siteProfiles[host] || {};
    const el = document.createElement('div');
    el.className = 'prof';

    const left = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'prof-host';
    name.textContent = host;
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const key of ['ads', 'images', 'media']) {
      if (typeof profile[key] !== 'boolean') continue;
      const chip = document.createElement('span');
      chip.className = profile[key] ? 'chip on' : 'chip';
      // "blocking ads" vs "allowing ads" — say which way the exception runs.
      chip.textContent = (profile[key] ? '✓ ' : '✕ ') + LABELS[key]();
      chips.appendChild(chip);
    }
    left.append(name, chips);

    const remove = document.createElement('button');
    remove.className = 'quiet';
    remove.type = 'button';
    remove.textContent = t('dashRemove') || 'Remove';
    remove.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ds-site-profile', hostname: host, profile: {} }, () => {
        void chrome.runtime.lastError;
        load();
      });
    });

    el.append(left, remove);
    box.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// Premium switches
// ---------------------------------------------------------------------------
function bindSwitches(settings, managedKeys) {
  for (const key of ['autoMode', 'consent', 'popups']) {
    const el = document.getElementById(key);
    el.checked = Boolean(settings[key]);
    // A managed setting is shown at its enforced value and locked, rather
    // than hidden — the user should be able to see what policy is doing.
    if (managedKeys.includes(key)) {
      el.disabled = true;
      continue;
    }
    el.onchange = () => chrome.storage.sync.set({ [key]: el.checked });
  }
  document.getElementById('managedNotice').classList.toggle('visible', managedKeys.length > 0);
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------
function initBackup() {
  const note = document.getElementById('ioNote');
  const say = (msg) => { note.textContent = msg; };

  document.getElementById('exportBtn').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ds-export' }, (res) => {
      void chrome.runtime.lastError;
      if (!res || !res.ok) { say(t('dashExportFailed') || 'Could not export settings.'); return; }

      const blob = new Blob([JSON.stringify(res.policy, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `data-saver-settings-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      // Revoking immediately can cancel the download in Chromium; one turn of
      // the event loop is enough for it to have started.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  });

  const file = document.getElementById('importFile');
  document.getElementById('importBtn').addEventListener('click', () => file.click());

  file.addEventListener('change', () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;
    const reader = new FileReader();

    reader.onload = () => {
      let parsed;
      try {
        parsed = JSON.parse(reader.result);
      } catch (e) {
        say(t('dashImportBadFile') || 'That file is not valid JSON.');
        return;
      }
      // background.js sanitises before writing — this side only reads the file.
      chrome.runtime.sendMessage({ type: 'ds-import', policy: parsed }, (res) => {
        void chrome.runtime.lastError;
        if (!res || !res.ok) {
          say((t('dashImportFailed') || 'Could not import that file.') + (res && res.error ? ` (${res.error})` : ''));
          return;
        }
        say(t('dashImported', String(res.applied.length)) || `Imported ${res.applied.length} settings.`);
        load();
      });
    };

    reader.onerror = () => say(t('dashImportFailed') || 'Could not read that file.');
    reader.readAsText(chosen);
    file.value = ''; // let the same file be picked again
  });
}

// ---------------------------------------------------------------------------
function load() {
  chrome.storage.local.get({ stats: {}, history: {}, siteStats: {} }, (local) => {
    renderHistory(local.history || {}, local.stats || {});
    renderTopSites(local.siteStats || {});
  });

  chrome.storage.sync.get(
    { siteProfiles: {}, autoMode: false, consent: false, popups: false },
    (settings) => {
      renderProfiles(settings.siteProfiles || {});
      const managed = chrome.storage.managed;
      if (!managed) { bindSwitches(settings, []); return; }
      managed.get(null, (policy) => {
        void chrome.runtime.lastError;
        bindSwitches(settings, Object.keys(policy || {}));
      });
    }
  );
}

document.addEventListener('DOMContentLoaded', () => {
  if (chrome.i18n.getMessage('@@bidi_dir') === 'rtl') document.body.setAttribute('dir', 'rtl');
  applyTranslations();
  initBackup();

  document.getElementById('clearHistory').addEventListener('click', () => {
    // Deliberately separate from the popup's Reset: this clears the record of
    // WHICH SITES were visited, which is the only browsing-shaped data the
    // extension keeps, and a user should be able to drop it on its own.
    chrome.storage.local.set({ history: {}, siteStats: {} }, load);
  });

  load();
});
