// Smoke tests for the v2.2 savings meter.
//
// There is no Chrome on this machine, so these run background.js and
// savings_counter.js inside a Node VM against a hand-stubbed `chrome` API.
// That will never catch a rendering bug, but it does cover the two things
// that fail silently in production: concurrent stats writes clobbering each
// other, and the counter mis-classifying or over-counting elements.
//
// Usage: node scripts/test-savings.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
const failures = [];

// Values created inside the VM have that realm's prototypes, which
// assert.deepEqual rejects even when the structure matches. Round-trip to
// this realm before comparing.
const plain = (v) => JSON.parse(JSON.stringify(v));

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push([name, e]);
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeStorageArea(initial = {}) {
  let store = { ...initial };
  return {
    _dump: () => ({ ...store }),
    _reset: (v = {}) => { store = { ...v }; },
    get(defaults, cb) {
      const out = {};
      for (const [k, d] of Object.entries(defaults)) out[k] = k in store ? store[k] : d;
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set(obj, cb) {
      Object.assign(store, obj);
      if (cb) { cb(); return; }
      return Promise.resolve();
    }
  };
}

function makeChrome() {
  const local = makeStorageArea();
  const sync = makeStorageArea();
  const listeners = { message: [], installed: [], startup: [], changed: [], command: [] };
  const registered = [];

  return {
    _listeners: listeners,
    _registered: registered,
    _local: local,
    runtime: {
      lastError: undefined,
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
      sendMessage: () => {}
    },
    storage: {
      local,
      sync,
      onChanged: { addListener: (f) => listeners.changed.push(f) }
    },
    scripting: {
      registerContentScripts: (s, cb) => { registered.push(...s.map((x) => x.id)); cb && cb(); },
      unregisterContentScripts: (_o, cb) => cb && cb()
    },
    commands: { onCommand: { addListener: (f) => listeners.command.push(f) } },
    action: {
      _badge: {}, _title: {},
      setBadgeText({ tabId, text }) { this._badge[tabId] = text; },
      setBadgeBackgroundColor() {},
      setTitle({ tabId, title }) { this._title[tabId] = title; }
    },
    declarativeNetRequest: {
      updateEnabledRulesets: (_o, cb) => cb && cb(),
      getDynamicRules: (cb) => cb([]),
      updateDynamicRules: (_o, cb) => cb && cb()
    },
    tabs: {
      _tabs: [{ id: 7, url: 'https://news.example.com/article', active: true }],
      _reloaded: [],
      create: () => {},
      query(_q, cb) { cb(this._tabs); },
      get(id, cb) { cb(this._tabs.find((t) => t.id === id)); },
      reload(id) { this._reloaded.push(id); },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} }
    }
  };
}

function loadBackground() {
  const chrome = makeChrome();
  // URL is a web/Node global, not an ECMAScript built-in, so a bare VM context
  // does not have it. Without it hostnameOf() silently returns null for every
  // page and the pause/badge paths look dead — a harness artifact, not a bug.
  // The frame lookup fetches the packaged ruleset; serve a small stand-in.
  const fakeRules = [
    { condition: { urlFilter: '||doubleclick.net^' } },
    { condition: { urlFilter: '||googlesyndication.com^' } },
    { condition: { urlFilter: '||scorecardresearch.com^' } }
  ];
  const fetchStub = () => Promise.resolve({ json: () => Promise.resolve(fakeRules) });

  const ctx = vm.createContext({
    chrome, console: { log() {}, warn() {} }, setTimeout, clearTimeout, Date, URL,
    fetch: fetchStub, Promise, Set, Object, JSON
  });
  vm.runInContext(readFileSync(join(ROOT, 'background.js'), 'utf8'), ctx);
  return { chrome, ctx };
}

const KB = 1024;

// ---------------------------------------------------------------------------
// background.js — stats accumulation
// ---------------------------------------------------------------------------

console.log('\nbackground.js — savings accumulation');

await test('accumulates counts and estimated bytes from one message', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];
  handler({ type: 'ds-blocked', counts: { ads: 2, images: 4, media: 1 } }, {}, () => {});
  await new Promise((r) => setImmediate(r));

  const { stats } = chrome._local._dump();
  assert.equal(stats.ads, 2);
  assert.equal(stats.images, 4);
  assert.equal(stats.media, 1);
  assert.equal(stats.bytes, 2 * 30 * KB + 4 * 35 * KB + 1 * 300 * KB);
  assert.ok(stats.since, 'since should be stamped on first write');
});

await test('concurrent messages do not clobber each other', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];

  // Fire 50 messages in the same tick — the failure mode this guards against is
  // read-modify-write interleaving, which silently loses increments.
  for (let i = 0; i < 50; i++) {
    handler({ type: 'ds-blocked', counts: { ads: 1, images: 2, media: 0 } }, {}, () => {});
  }
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

  const { stats } = chrome._local._dump();
  assert.equal(stats.ads, 50, `expected 50 ads, got ${stats.ads}`);
  assert.equal(stats.images, 100, `expected 100 images, got ${stats.images}`);
});

await test('ignores messages that are not ours', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];
  handler({ type: 'something-else', counts: { ads: 9 } }, {}, () => {});
  handler(null, {}, () => {});
  handler({ type: 'ds-blocked' }, {}, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(chrome._local._dump().stats, undefined, 'no stats should be written');
});

await test('"since" is stamped once and never moves', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];
  handler({ type: 'ds-blocked', counts: { ads: 1 } }, {}, () => {});
  await new Promise((r) => setImmediate(r));
  const first = chrome._local._dump().stats.since;

  handler({ type: 'ds-blocked', counts: { ads: 1 } }, {}, () => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(chrome._local._dump().stats.since, first);
});

// ---------------------------------------------------------------------------
// background.js — script registration
// ---------------------------------------------------------------------------

console.log('\nbackground.js — content script registration');

await test('counter registers when any blocker is on, and not when all are off', async () => {
  for (const [settings, shouldRun] of [
    [{ ads: true, images: false, media: false }, true],
    [{ ads: false, images: true, media: false }, true],
    [{ ads: false, images: false, media: true }, true],
    [{ ads: false, images: false, media: false }, false]
  ]) {
    const { chrome, ctx } = loadBackground();
    vm.runInContext('refreshAll', ctx)({ ...settings, allowlist: [] });
    const has = chrome._registered.includes('data-saver-savings-counter');
    assert.equal(has, shouldRun, `counter with ${JSON.stringify(settings)} should be ${shouldRun}`);
  }
});

await test('paused sites are excluded from the counter too', async () => {
  const { chrome, ctx } = loadBackground();
  let captured = null;
  chrome.scripting.registerContentScripts = (s, cb) => {
    const c = s.find((x) => x.id === 'data-saver-savings-counter');
    if (c) captured = c;
    cb && cb();
  };
  vm.runInContext('refreshAll', ctx)({ ads: true, images: true, media: true, allowlist: ['example.com'] });
  assert.ok(captured, 'counter script should have been registered');
  // Cross-realm values carry a different Object/Array prototype, so compare plain copies.
  assert.deepEqual(plain(captured.excludeMatches), ['*://example.com/*', '*://*.example.com/*']);
});

await test('welcome tab opens on install only, never on update', async () => {
  const { chrome, ctx } = loadBackground();
  const opened = [];
  chrome.tabs.create = (o) => opened.push(o.url);
  const onInstalled = chrome._listeners.installed[0];

  onInstalled({ reason: 'update' });
  assert.equal(opened.length, 0, 'update must not open a tab');

  onInstalled({ reason: 'install' });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /welcome\.html$/);
});

// ---------------------------------------------------------------------------
// background.js — per-site pause (the primary escape hatch)
// ---------------------------------------------------------------------------

console.log('\nbackground.js — per-site pause');

const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

await test('toggle message adds then removes the host from the allowlist', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];

  handler({ type: 'ds-toggle-site', hostname: 'news.example.com' }, {}, () => {});
  await settle();
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), ['news.example.com']);

  handler({ type: 'ds-toggle-site', hostname: 'news.example.com' }, {}, () => {});
  await settle();
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), []);
});

await test('toggle replies with the resulting paused state', async () => {
  const { chrome } = loadBackground();
  const handler = chrome._listeners.message[0];
  let reply = null;
  handler({ type: 'ds-toggle-site', hostname: 'a.example' }, {}, (r) => { reply = r; });
  await settle();
  assert.equal(plain(reply).paused, true, 'first toggle should pause');
});

await test('keyboard shortcut pauses the active tab and reloads it', async () => {
  const { chrome } = loadBackground();
  const onCommand = chrome._listeners.command[0];
  assert.ok(onCommand, 'a command listener should be registered');

  onCommand('toggle-site');
  await settle();
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), ['news.example.com']);
  assert.deepEqual(plain(chrome.tabs._reloaded), [7], 'the page must reload to take effect');
});

await test('an unrelated command is ignored', async () => {
  const { chrome } = loadBackground();
  chrome._listeners.command[0]('some-other-command');
  await settle();
  assert.equal(chrome.storage.sync._dump().allowlist, undefined);
});

await test('badge reads OFF only where blocking is paused', async () => {
  const { chrome, ctx } = loadBackground();
  const updateBadge = vm.runInContext('updateBadge', ctx);

  chrome.storage.sync.set({ allowlist: ['paused.example'] });
  updateBadge(1, 'https://paused.example/page');
  updateBadge(2, 'https://active.example/page');
  await settle();

  assert.equal(chrome.action._badge[1], 'OFF');
  assert.equal(chrome.action._badge[2], '');
  assert.match(chrome.action._title[1], /paused on paused\.example/);
});

await test('pages with no host clear the badge instead of throwing', async () => {
  const { chrome, ctx } = loadBackground();
  const updateBadge = vm.runInContext('updateBadge', ctx);
  for (const url of ['chrome://extensions', 'about:blank', '', undefined]) {
    updateBadge(3, url);
  }
  await settle();
  assert.equal(chrome.action._badge[3], '');
});

// ---------------------------------------------------------------------------
// background.js — YouTube ships unblocked
// ---------------------------------------------------------------------------

console.log('\nbackground.js — default allowlist');

await test('a fresh install ships the video platforms unblocked', async () => {
  const { chrome, ctx } = loadBackground();
  const defaults = plain(vm.runInContext('DEFAULT_ALLOWLIST', ctx));
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  const { allowlist, seededDefaults } = chrome.storage.sync._dump();
  assert.deepEqual(plain(allowlist).sort(), [...defaults].sort());
  assert.deepEqual(plain(seededDefaults).sort(), [...defaults].sort());
  for (const d of ['youtube.com', 'netflix.com', 'twitch.tv', 'tiktok.com', 'instagram.com']) {
    assert.ok(defaults.includes(d), `${d} should be a default`);
  }
});

await test('seeding preserves a user\'s existing allowlist', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['mysite.example'] });
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  const list = plain(chrome.storage.sync._dump().allowlist);
  assert.ok(list.includes('mysite.example'), 'user entry must survive seeding');
  assert.ok(list.includes('netflix.com'), 'defaults must still be added');
});

await test('seeding runs once per entry — resuming on YouTube sticks', async () => {
  const { chrome, ctx } = loadBackground();
  const seed = vm.runInContext('seedDefaultAllowlist', ctx);
  await seed();

  await vm.runInContext('toggleSite', ctx)('www.youtube.com');
  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('youtube.com'));

  // A later browser restart must not quietly put it back.
  await seed();
  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('youtube.com'),
            'youtube.com came back after the user removed it');
});

await test('adding a NEW default later does not resurrect removed ones', async () => {
  const { chrome, ctx } = loadBackground();
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  await vm.runInContext('toggleSite', ctx)('netflix.com');
  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('netflix.com'));

  // Simulate a future release that appends an entry to DEFAULT_ALLOWLIST.
  vm.runInContext("DEFAULT_ALLOWLIST.push('newvideo.example')", ctx);
  await vm.runInContext('seedDefaultAllowlist', ctx)();

  const list = plain(chrome.storage.sync._dump().allowlist);
  assert.ok(list.includes('newvideo.example'), 'the new default should be added');
  assert.ok(!list.includes('netflix.com'), 'a removed default must stay removed');
});

await test('upgrading from the v2.2 boolean flag adds only the new entries', async () => {
  const { chrome, ctx } = loadBackground();
  // v2.2 state: boolean flag set, and the user had already removed youtube.com.
  chrome.storage.sync.set({ allowlist: ['mysite.example'], defaultsSeeded: true });
  await vm.runInContext('seedDefaultAllowlist', ctx)();

  const list = plain(chrome.storage.sync._dump().allowlist);
  assert.ok(!list.includes('youtube.com'), 'v2.2 removal must be respected');
  assert.ok(list.includes('netflix.com'), 'genuinely new defaults should arrive');
  assert.ok(list.includes('mysite.example'));
});

await test('a storage failure during seeding still turns blocking on', async () => {
  const { chrome } = loadBackground();

  // Reject only the promise form (seeding); the callback form that
  // loadAndSetInitialState uses keeps working, as it would in the browser.
  const realGet = chrome.storage.sync.get.bind(chrome.storage.sync);
  chrome.storage.sync.get = (defaults, cb) =>
    cb ? realGet(defaults, cb) : Promise.reject(new Error('QUOTA_BYTES quota exceeded'));

  let applied = null;
  chrome.declarativeNetRequest.updateEnabledRulesets = (o, cb) => { applied = o; cb && cb(); };

  chrome._listeners.installed[0]({ reason: 'install' });
  await settle(12);

  assert.ok(applied, 'rulesets were never applied — the extension installed inert');
  assert.deepEqual(plain(applied.enableRulesetIds).sort(),
                   ['ad-domains', 'ads', 'images', 'media']);
  assert.ok(chrome._registered.includes('data-saver-savings-counter'),
            'content scripts were never registered');
});

await test('a failed toggle still answers the popup instead of hanging it', async () => {
  const { chrome } = loadBackground();
  const realGet = chrome.storage.sync.get.bind(chrome.storage.sync);
  chrome.storage.sync.get = (defaults, cb) =>
    cb ? realGet(defaults, cb) : Promise.reject(new Error('storage unavailable'));

  let reply = 'never called';
  chrome._listeners.message[0](
    { type: 'ds-toggle-site', hostname: 'example.com' }, {}, (r) => { reply = r; });
  await settle(10);

  assert.notEqual(reply, 'never called',
                  'popup button would stay disabled and the popup never close');
  assert.equal(plain(reply).ok, false);
});

await test('subdomains count as allowlisted', async () => {
  const { ctx } = loadBackground();
  const isAllowlisted = vm.runInContext('isAllowlisted', ctx);
  const list = ['youtube.com'];
  for (const h of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']) {
    assert.equal(isAllowlisted(h, list), true, `${h} should be allowlisted`);
  }
  // Must not match a lookalike registered domain.
  for (const h of ['notyoutube.com', 'youtube.com.evil.test', 'example.com']) {
    assert.equal(isAllowlisted(h, list), false, `${h} must NOT be allowlisted`);
  }
});

await test('resuming from a subdomain removes the covering entry', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['youtube.com'] });
  // Naively this would append 'www.youtube.com' and change nothing.
  const paused = await vm.runInContext('toggleSite', ctx)('www.youtube.com');
  assert.equal(paused, false, 'toggling should report blocking resumed');
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), []);
});

await test('popup state query agrees with the rules on www.youtube.com', async () => {
  const { chrome } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['youtube.com'] });
  const handler = chrome._listeners.message[0];
  let reply = null;
  handler({ type: 'ds-site-state', hostname: 'www.youtube.com' }, {}, (r) => { reply = r; });
  await settle();
  assert.equal(plain(reply).paused, true,
               'popup would have shown "Blocking active" while rules allowed it');
});

await test('badge reads OFF on a YouTube subdomain', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['youtube.com'] });
  vm.runInContext('updateBadge', ctx)(9, 'https://m.youtube.com/watch?v=x');
  await settle();
  assert.equal(chrome.action._badge[9], 'OFF');
});

// ---------------------------------------------------------------------------
// background.js — blocked frames & remembered choices
// ---------------------------------------------------------------------------

console.log('\nbackground.js — blocked frames');

await test('frames on blocklisted domains count as ads', async () => {
  const { chrome } = loadBackground();
  chrome._listeners.message[0](
    { type: 'ds-blocked', counts: { ads: 0, images: 3, media: 0 },
      frames: ['doubleclick.net', 'tpc.googlesyndication.com',
               'tpc.googlesyndication.com', 'cdn.example.com'] },
    {}, () => {});
  await settle(14);

  const { stats } = chrome._local._dump();
  // Three of the four are on the blocklist. The repeated googlesyndication
  // host counts twice — ad networks place several frames from one host.
  assert.equal(stats.ads, 3, `expected 3 ad frames, got ${stats.ads}`);
  assert.equal(stats.images, 3);
});

await test('frames on an allowlisted site are not counted', async () => {
  const { chrome } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['news.example'] });
  chrome._listeners.message[0](
    { type: 'ds-blocked', counts: { ads: 0, images: 0, media: 0 },
      frames: ['ads.news.example'] }, {}, () => {});
  await settle(14);
  assert.equal((chrome._local._dump().stats || {}).ads || 0, 0,
               'nothing is blocked on an allowlisted site, so nothing may be counted');
});

await test('frames are not counted while ad blocking is switched off', async () => {
  const { chrome } = loadBackground();
  chrome.storage.sync.set({ ads: false });
  chrome._listeners.message[0](
    { type: 'ds-blocked', counts: { ads: 0, images: 0, media: 0 },
      frames: ['doubleclick.net'] }, {}, () => {});
  await settle(14);
  assert.equal((chrome._local._dump().stats || {}).ads || 0, 0);
});

console.log('\nbackground.js — remembered user choices');

await test('every manual toggle is recorded as an explicit choice', async () => {
  const { chrome, ctx } = loadBackground();
  const toggle = vm.runInContext('toggleSite', ctx);

  await toggle('shop.example');           // user chose NOT to block
  assert.equal(plain(chrome.storage.sync._dump().userChoices)['shop.example'], true);

  await toggle('shop.example');           // user chose TO block
  assert.equal(plain(chrome.storage.sync._dump().userChoices)['shop.example'], false);
});

await test('a choice to block is recorded against the covering entry', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['youtube.com'] });
  await vm.runInContext('toggleSite', ctx)('www.youtube.com');
  // Recorded against youtube.com, which is what any future default would add.
  assert.equal(plain(chrome.storage.sync._dump().userChoices)['youtube.com'], false);
});

await test('a site the user chose to block is never re-added as a new default', async () => {
  const { chrome, ctx } = loadBackground();
  // User blocks a site that is not yet a default.
  chrome.storage.sync.set({ allowlist: ['later.example'] });
  await vm.runInContext('toggleSite', ctx)('later.example');
  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('later.example'));

  // A later release adds it to DEFAULT_ALLOWLIST.
  vm.runInContext("DEFAULT_ALLOWLIST.push('later.example')", ctx);
  await vm.runInContext('seedDefaultAllowlist', ctx)();

  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('later.example'),
            "a shipped default overrode the user's own decision");
});

// ---------------------------------------------------------------------------
// background.js — review prompt gate
// ---------------------------------------------------------------------------

console.log('\nbackground.js — review prompt');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 15);
// Comfortably over both thresholds, so each test below fails for exactly the
// one reason it is testing rather than incidentally.
const RICH = { ads: 9000, images: 7000, media: 500, bytes: 1, since: null };

function gate(ctx, over) {
  return vm.runInContext('shouldAskForReview', ctx)(
    Object.assign({ stats: RICH, review: null, installedAt: NOW - 40 * DAY, now: NOW }, over)
  );
}

await test('asks once the user is past both the count and the age threshold', async () => {
  const { ctx } = loadBackground();
  assert.equal(gate(ctx), true);
});

await test('does not ask below the blocked-request threshold', async () => {
  const { ctx } = loadBackground();
  assert.equal(gate(ctx, { stats: { ads: 100, images: 200, media: 3 } }), false);
});

await test('counts ads, images and media together toward the threshold', async () => {
  const { ctx } = loadBackground();
  // None of the three is individually large; the total is what matters.
  assert.equal(gate(ctx, { stats: { ads: 5000, images: 5000, media: 5000 } }), true);
  assert.equal(gate(ctx, { stats: { ads: 4999, images: 4999, media: 4999 } }), false);
});

await test('does not ask before 15 days, however much was blocked', async () => {
  const { ctx } = loadBackground();
  // The whole point of the age gate: churn is front-loaded, so a heavy user on
  // day 14 is exactly the person who should not be prompted yet.
  assert.equal(gate(ctx, { installedAt: NOW - 14 * DAY }), false);
  assert.equal(gate(ctx, { installedAt: NOW - 15 * DAY }), true);
});

await test('falls back to stats.since when there is no install date', async () => {
  const { ctx } = loadBackground();
  assert.equal(gate(ctx, { installedAt: null, stats: { ...RICH, since: NOW - 40 * DAY } }), true);
  assert.equal(gate(ctx, { installedAt: null, stats: { ...RICH, since: NOW - 3 * DAY } }), false);
});

await test('never asks when there is no date to count from', async () => {
  const { ctx } = loadBackground();
  assert.equal(gate(ctx, { installedAt: null, stats: { ...RICH, since: null } }), false);
});

await test('never asks again once the user has rated', async () => {
  const { ctx } = loadBackground();
  assert.equal(gate(ctx, { review: { asks: 0, snoozeUntil: null, done: true } }), false);
});

await test('stays quiet during the snooze window, then asks again', async () => {
  const { ctx } = loadBackground();
  const snoozed = { asks: 1, snoozeUntil: NOW + 5 * DAY, done: false };
  assert.equal(gate(ctx, { review: snoozed }), false);
  assert.equal(gate(ctx, { review: { ...snoozed, snoozeUntil: NOW - 1 } }), true);
});

await test('gives up permanently after two dismissals', async () => {
  const { ctx } = loadBackground();
  // Budget spent and the snooze long expired — still silent.
  assert.equal(gate(ctx, { review: { asks: 2, snoozeUntil: NOW - 100 * DAY, done: false } }), false);
});

await test('dismissing spends one ask and pushes the next one out', async () => {
  const { chrome, ctx } = loadBackground();
  const record = vm.runInContext('recordReviewAction', ctx);
  await record('later', NOW);
  const r = plain(chrome.storage.local._dump().review);
  assert.equal(r.asks, 1);
  assert.equal(r.done, false);
  assert.equal(r.snoozeUntil, NOW + 20 * DAY);
});

await test('rating closes the prompt for good', async () => {
  const { chrome, ctx } = loadBackground();
  await vm.runInContext('recordReviewAction', ctx)('rated', NOW);
  assert.equal(plain(chrome.storage.local._dump().review).done, true);
});

await test('review state reports the exact blocked total the prompt quotes', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.local.set({ stats: RICH, installedAt: NOW - 40 * DAY });
  const state = plain(await vm.runInContext('getReviewState', ctx)(NOW));
  assert.equal(state.show, true);
  assert.equal(state.total, 16500);
});

await test('install stamps a date once and never moves it', async () => {
  const { chrome, ctx } = loadBackground();
  // Deliberately not Date.now(): a re-stamp would land in the same millisecond
  // and compare equal, so the test would pass whether or not the guard exists.
  const first = NOW - 40 * DAY;
  chrome.storage.local.set({ installedAt: first });
  for (const fn of chrome._listeners.installed) fn({ reason: 'update' });
  await Promise.resolve();
  assert.equal(plain(chrome.storage.local._dump().installedAt), first,
               'an update re-stamped the install date and pushed the prompt out');
});

// ---------------------------------------------------------------------------
// savings_counter.js — classification
// ---------------------------------------------------------------------------

console.log('\nsavings_counter.js — classification & batching');

function loadCounter() {
  let errorHandler = null;
  const sent = [];
  const timers = [];

  const doc = {
    addEventListener: (type, fn, capture) => {
      if (type === 'error' && capture === true) errorHandler = fn;
    },
    visibilityState: 'visible'
  };

  const ctx = vm.createContext({
    document: doc,
    window: { addEventListener: () => {} },
    chrome: {
      runtime: {
        lastError: undefined,
        sendMessage: (msg, cb) => { sent.push(msg); cb && cb(); }
      }
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}
  });

  vm.runInContext(readFileSync(join(ROOT, 'savings_counter.js'), 'utf8'), ctx);
  return { fire: (tag, src = 'https://x/y') => errorHandler({ target: { nodeType: 1, tagName: tag, src, getAttribute: () => src } }), sent, flush: () => timers.forEach((f) => f()) };
}

await test('classifies elements into ads / images / media', async () => {
  const c = loadCounter();
  c.fire('IMG'); c.fire('IMG');
  // SCRIPT and OBJECT both fire 'error' when blocked; IFRAME does not and is
  // handled by the background lookup instead.
  c.fire('SCRIPT'); c.fire('OBJECT');
  c.fire('VIDEO'); c.fire('AUDIO'); c.fire('SOURCE');
  c.flush();
  assert.equal(c.sent.length, 1, 'should batch into a single message');
  assert.deepEqual(plain(c.sent[0].counts), { ads: 2, images: 2, media: 3 });
});

await test('an error on an IFRAME is ignored — frames go through the lookup', async () => {
  const c = loadCounter();
  c.fire('IFRAME');
  c.flush();
  assert.equal(c.sent.length, 0,
               'counting an iframe error here would double-count it');
});

await test('ignores element types we do not block', async () => {
  const c = loadCounter();
  // EMBED fires nothing at all when blocked (measured), so it is not in the map
  // even though it can carry an ad.
  c.fire('LINK'); c.fire('DIV'); c.fire('EMBED');
  c.flush();
  assert.equal(c.sent.length, 0, 'nothing should be sent');
});

await test('ignores elements with no source (never made a request)', async () => {
  const c = loadCounter();
  c.fire('IMG', '');
  c.flush();
  assert.equal(c.sent.length, 0);
});

await test('does not send an empty batch', async () => {
  const c = loadCounter();
  c.flush();
  assert.equal(c.sent.length, 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [name, e] of failures) console.error(`\n${name}\n${e.stack}`);
  process.exit(1);
}
