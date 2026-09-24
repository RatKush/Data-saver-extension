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

  // The popup used to carry this line. It belongs somewhere, because an
  // all-time figure means nothing without knowing when it started.
  const since = document.getElementById('tSince');
  if (since) {
    since.textContent = stats.since
      ? (t('savingsEstimatedSince', shortDate(stats.since)) || `since ${shortDate(stats.since)}`)
      : '';
  }

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
function renderTopSites(siteStats, enabled) {
  const box = document.getElementById('topSites');
  box.textContent = '';

  const rows = Object.entries(siteStats)
    .map(([host, v]) => ({ host, n: v.n || 0 }))
    .filter((r) => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);

  if (!enabled) {
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = t('dashTopSitesOff')
      || 'Site history is off, so nothing is recorded. Turn it on above to see where the savings come from.';
    box.appendChild(p);
    return;
  }

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

// A paused site is the strongest per-site rule there is — nothing is blocked
// there at all — but it lives in the allowlist rather than siteProfiles, so
// this page used to show "No per-site rules yet" while sites were paused. They
// are listed first now, each with a way to resume. The sites that ship paused
// (video platforms and calls) are grouped and folded away: thirty rows of
// defaults would bury the few the user chose.
function pausedRow(host, locked) {
  const el = document.createElement('div');
  el.className = 'prof';
  const left = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'prof-host';
  name.textContent = host;
  const chips = document.createElement('div');
  chips.className = 'chips';
  const chip = document.createElement('span');
  chip.className = 'chip on';
  chip.textContent = t('dashPausedChip') || 'Paused — nothing blocked';
  chips.appendChild(chip);
  left.append(name, chips);
  el.appendChild(left);

  if (!locked) {
    const resume = document.createElement('button');
    resume.className = 'quiet';
    resume.type = 'button';
    resume.textContent = t('siteResume') || 'Resume blocking here';
    resume.addEventListener('click', () => {
      resume.disabled = true;
      // The same path the popup and the shortcut use, so the choice is
      // remembered in userChoices and a shipped default stays resumed.
      chrome.runtime.sendMessage({ type: 'ds-toggle-site', hostname: host }, () => {
        void chrome.runtime.lastError;
        load();
      });
    });
    el.appendChild(resume);
  }
  return el;
}

function renderPaused(box, sync, managedKeys) {
  const locked = managedKeys.includes('allowlist');
  const offered = new Set(sync.seededDefaults || []);
  const choices = sync.userChoices || {};
  const all = (sync.allowlist || []).slice().sort();
  const shipped = all.filter((d) => offered.has(d) && choices[d] !== true);
  const chosen = all.filter((d) => !shipped.includes(d));

  for (const host of chosen) box.appendChild(pausedRow(host, locked));

  if (shipped.length) {
    const group = document.createElement('details');
    group.className = 'shipped';
    const summary = document.createElement('summary');
    summary.textContent = t('dashShippedPaused', String(shipped.length))
      || `Video and call sites that ship unblocked (${shipped.length})`;
    group.appendChild(summary);
    for (const host of shipped) group.appendChild(pausedRow(host, locked));
    box.appendChild(group);
  }
  return all.length;
}

function renderProfiles(siteProfiles, sync, managedKeys) {
  const box = document.getElementById('profiles');
  box.textContent = '';

  const paused = renderPaused(box, sync || {}, managedKeys || []);
  const hosts = Object.keys(siteProfiles).sort();
  if (!hosts.length && paused) return;
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
      // Say which way the exception runs in words. The old "✕ images" read as
      // "images blocked" when it meant the opposite.
      chip.textContent = profile[key]
        ? (t('dashChipBlocked', LABELS[key]()) || `Blocking ${LABELS[key]()}`)
        : (t('dashChipAllowed', LABELS[key]()) || `Allowing ${LABELS[key]()}`);
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
  for (const key of ['siteHistory', 'autoMode', 'consent', 'popups', 'budgetEnabled']) {
    const el = document.getElementById(key);
    el.checked = Boolean(settings[key]);
    // A managed setting is shown at its enforced value and locked, rather
    // than hidden — the user should be able to see what policy is doing.
    if (managedKeys.includes(key)) {
      el.disabled = true;
      continue;
    }
    el.onchange = () => chrome.storage.sync.set({ [key]: el.checked }, () => {
      // background.js clears the recorded sites when this goes off; re-read
      // so the page shows that straight away rather than stale rows.
      if (key === 'siteHistory' || key === 'budgetEnabled') load();
    });
  }
  document.getElementById('managedNotice').classList.toggle('visible', managedKeys.length > 0);
}

// ---------------------------------------------------------------------------
// Data budget
// ---------------------------------------------------------------------------
const STAGE_LABEL = {
  relaxed: 'budgetRelaxed', normal: 'budgetNormal',
  tight: 'budgetTight', strict: 'budgetStrict'
};

function renderBudget(settings) {
  const period = document.getElementById('budgetPeriod');
  const dailyGb = document.getElementById('budgetDailyGB');
  const gb = document.getElementById('budgetGB');
  const day = document.getElementById('budgetResetDay');
  const badge = document.getElementById('budgetStage');
  const on = Boolean(settings.budgetEnabled);
  const daily = settings.budgetPeriod === 'day';

  // Stored in MB so the pacing maths has no fractions; shown in GB because
  // that is the unit every carrier quotes.
  period.value = daily ? 'day' : 'month';
  dailyGb.value = settings.budgetDailyMB ? (settings.budgetDailyMB / 1024) : '';
  gb.value = settings.budgetMB ? (settings.budgetMB / 1024) : '';
  day.value = settings.budgetResetDay || 1;
  period.disabled = dailyGb.disabled = gb.disabled = day.disabled = !on;

  // Only the fields for the chosen plan are shown. Both allowances are kept,
  // so switching back and forth never loses what was typed.
  document.getElementById('dailyField').hidden = !daily;
  document.getElementById('monthlyField').hidden = daily;
  document.getElementById('resetField').hidden = daily;

  period.onchange = () => chrome.storage.sync.set({ budgetPeriod: period.value }, load);
  dailyGb.onchange = () => {
    const value = Math.max(0, parseFloat(dailyGb.value) || 0);
    chrome.storage.sync.set({ budgetDailyMB: Math.round(value * 1024) }, load);
  };
  gb.onchange = () => {
    const value = Math.max(0, parseFloat(gb.value) || 0);
    chrome.storage.sync.set({ budgetMB: Math.round(value * 1024) }, load);
  };
  day.onchange = () => {
    // Clamped to 28 for the same reason cycleInfo clamps it: the anchor has
    // to exist in February.
    const value = Math.min(Math.max(parseInt(day.value, 10) || 1, 1), 28);
    day.value = value;
    chrome.storage.sync.set({ budgetResetDay: value }, load);
  };

  if (!on) { badge.hidden = true; return; }

  chrome.runtime.sendMessage({ type: 'ds-budget-state' }, (res) => {
    void chrome.runtime.lastError;
    if (!res || !res.enabled) { badge.hidden = true; return; }
    badge.textContent = budgetLine(res);
    badge.hidden = false;
  });
}

// Shared shape with popup.js: "Day 3 of 30 \u00b7 Normal" on a monthly plan,
// "Today: about 820 MB of 1.5 GB \u00b7 Normal" on a daily one.
function budgetLine(res) {
  const stage = t(STAGE_LABEL[res.stage]) || res.stage;
  if (res.period === 'day' && res.allowanceBytes > 0) {
    const used = formatBytes(res.usedBytes);
    const allowance = formatBytes(res.allowanceBytes);
    return t('dashBudgetToday', used, allowance, stage) || `Today: about ${used} of ${allowance} \u00b7 ${stage}`;
  }
  return t('dashBudgetNow', String(res.day), String(res.days), stage)
    || `Day ${res.day} of ${res.days} \u00b7 ${stage}`;
}

// ---------------------------------------------------------------------------
// Data used
// ---------------------------------------------------------------------------
function formatBytes(bytes) {
  const n = bytes || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

// Usage keys are LOCAL dates (background.js localDayKey) \u2014 a daily plan
// resets at the user's midnight \u2014 unlike the savings history, which is UTC.
function localDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function renderUsage(usage) {
  const now = Date.now();
  const on = (i) => usage[localDayKey(now - i * DAY_MS)] || 0;
  const sum = (n) => { let out = 0; for (let i = 0; i < n; i++) out += on(i); return out; };

  document.getElementById('uToday').textContent = formatBytes(on(0));
  document.getElementById('u7').textContent = formatBytes(sum(7));
  document.getElementById('u30').textContent = formatBytes(sum(30));

  const trend = document.getElementById('usageTrend');
  trend.textContent = '';
  const days = [];
  for (let i = 13; i >= 0; i--) days.push({ ts: now - i * DAY_MS, bytes: on(i) });
  const peak = Math.max(1, ...days.map((d) => d.bytes));
  for (const day of days) {
    const bar = document.createElement('div');
    bar.style.height = `${Math.max((day.bytes / peak) * 100, 2)}%`;
    bar.title = `${shortDate(day.ts)} \u2014 ${formatBytes(day.bytes)}`;
    if (!day.bytes) bar.style.opacity = '0.25';
    trend.appendChild(bar);
  }
  document.getElementById('usageFrom').textContent = shortDate(days[0].ts);
  document.getElementById('usageTo').textContent = shortDate(days[days.length - 1].ts);
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
  chrome.storage.sync.get(
    { siteProfiles: {}, autoMode: false, consent: false, popups: false, siteHistory: false,
      budgetEnabled: false, budgetPeriod: 'month', budgetMB: 0, budgetResetDay: 1, budgetDailyMB: 0,
      allowlist: [], seededDefaults: [], userChoices: {} },
    (settings) => {
      renderBudget(settings);

      chrome.storage.local.get({ stats: {}, history: {}, siteStats: {}, usage: {} }, (local) => {
        renderUsage(local.usage || {});
        renderHistory(local.history || {}, local.stats || {});
        // Read together, because whether the list should appear at all is a
        // sync setting while the list itself is local.
        renderTopSites(local.siteStats || {}, Boolean(settings.siteHistory));
      });

      const managed = chrome.storage.managed;
      const withPolicy = (policy) => {
        const keys = Object.keys(policy || {});
        // A managed allowlist replaces the user's, so show what is enforced.
        const sync = Array.isArray(policy && policy.allowlist)
          ? Object.assign({}, settings, { allowlist: policy.allowlist }) : settings;
        renderProfiles(settings.siteProfiles || {}, sync, keys);
        bindSwitches(settings, keys);
      };
      if (!managed) { withPolicy({}); return; }
      managed.get(null, (policy) => {
        void chrome.runtime.lastError;
        withPolicy(policy);
      });
    }
  );
}

document.addEventListener('DOMContentLoaded', () => {
  if (chrome.i18n.getMessage('@@bidi_dir') === 'rtl') document.body.setAttribute('dir', 'rtl');
  applyTranslations();
  initBackup();

  // Resetting the counter is separate from clearing history: one throws away
  // the totals, the other throws away the record of which sites produced them.
  document.getElementById('resetStats').addEventListener('click', () => {
    chrome.storage.local.set(
      { stats: { ads: 0, images: 0, media: 0, bytes: 0, since: Date.now() } }, load);
  });

  document.getElementById('clearHistory').addEventListener('click', () => {
    // Deliberately separate from the popup's Reset: this clears the record of
    // WHICH SITES were visited, which is the only browsing-shaped data the
    // extension keeps, and a user should be able to drop it on its own.
    chrome.storage.local.set({ history: {}, siteStats: {} }, load);
  });

  load();
});
