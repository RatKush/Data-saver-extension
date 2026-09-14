// Smoke tests for the savings meter and everything built on it.
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
// background.js — premium features
// ---------------------------------------------------------------------------

console.log('\nbackground.js — per-site profiles');

await test('a profile applies to subdomains, and the longest match wins', async () => {
  const { ctx } = loadBackground();
  const entry = vm.runInContext('profileEntryFor', ctx);
  const profiles = { 'example.com': {}, 'news.example.com': {} };
  assert.equal(entry('example.com', profiles), 'example.com');
  assert.equal(entry('www.example.com', profiles), 'example.com');
  assert.equal(entry('news.example.com', profiles), 'news.example.com');
  assert.equal(entry('a.news.example.com', profiles), 'news.example.com');
  // A lookalike must not match, same rule as the allowlist.
  assert.equal(entry('notexample.com', profiles), null);
});

await test('a profile overrides only the categories it names', async () => {
  const { ctx } = loadBackground();
  const eff = vm.runInContext('effectiveSettings', ctx);
  const data = { ads: true, images: true, media: true, siteProfiles: { 'example.com': { images: false } } };
  assert.deepEqual(plain(eff('www.example.com', data)), { ads: true, images: false, media: true });
  assert.deepEqual(plain(eff('other.test', data)), { ads: true, images: true, media: true });
});

await test('an allow rule is emitted only where a site opts out', async () => {
  const { ctx } = loadBackground();
  const rules = plain(vm.runInContext('siteProfileRules', ctx)(
    { ads: true, images: true, media: true, siteProfiles: { 'example.com': { images: false, media: true } } }, 1));
  assert.equal(rules.length, 1, 'media:true needs no rule — the static ruleset already blocks it');
  assert.equal(rules[0].action.type, 'allow');
  assert.deepEqual(rules[0].condition.resourceTypes, ['image']);
  assert.deepEqual(rules[0].condition.initiatorDomains, ['example.com']);
});

await test('no rule is emitted when the category is globally off anyway', async () => {
  const { ctx } = loadBackground();
  const rules = plain(vm.runInContext('siteProfileRules', ctx)(
    { ads: true, images: false, media: true, siteProfiles: { 'example.com': { images: false } } }, 1));
  assert.equal(rules.length, 0);
});

await test('unblocking ads on a site does not also unblock its images', async () => {
  const { ctx } = loadBackground();
  const rules = plain(vm.runInContext('siteProfileRules', ctx)(
    { ads: true, images: true, media: true, siteProfiles: { 'example.com': { ads: false } } }, 1));
  const types = rules[0].condition.resourceTypes;
  assert.ok(!types.includes('image'), 'an ads exception leaked into image blocking');
  assert.ok(!types.includes('media'), 'an ads exception leaked into media blocking');
  assert.ok(types.includes('script'));
});

await test('profile rules sit below a full pause but above the statics', async () => {
  const { ctx } = loadBackground();
  const pause = vm.runInContext('ALLOWLIST_RULE_PRIORITY', ctx);
  const profile = vm.runInContext('SITE_PROFILE_RULE_PRIORITY', ctx);
  assert.ok(profile < pause, 'a profile could override a paused site');
  assert.ok(profile > 1, 'a profile would lose to the static block rules');
});

await test('a profile that matches the globals is not stored', async () => {
  const { chrome, ctx } = loadBackground();
  const set = vm.runInContext('setSiteProfile', ctx);
  await set('example.com', { images: false });
  assert.deepEqual(plain(chrome.storage.sync._dump().siteProfiles), { 'example.com': { images: false } });
  await set('example.com', {});
  assert.deepEqual(plain(chrome.storage.sync._dump().siteProfiles), {});
});

await test('editing from a subdomain updates the covering rule', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ siteProfiles: { 'example.com': { images: false } } });
  await vm.runInContext('setSiteProfile', ctx)('www.example.com', { images: false, media: false });
  const stored = plain(chrome.storage.sync._dump().siteProfiles);
  assert.deepEqual(Object.keys(stored), ['example.com'], 'a narrower duplicate rule was added');
  assert.deepEqual(stored['example.com'], { images: false, media: false });
});

console.log('\nbackground.js — sync quota caps');

await test('site profiles stay under the sync per-item cap', async () => {
  const { chrome, ctx } = loadBackground();
  const max = vm.runInContext('SITE_PROFILES_MAX', ctx);
  const set = vm.runInContext('setSiteProfile', ctx);
  for (let i = 0; i < max + 20; i++) await set(`s${i}.example`, { images: false });

  const stored = plain(chrome.storage.sync._dump().siteProfiles);
  assert.equal(Object.keys(stored).length, max);
  assert.ok(stored[`s${max + 19}.example`], 'the newest rule was dropped');
  assert.ok(!stored['s0.example'], 'the oldest rule survived the cap');

  // The whole point of the cap: the item still fits in what sync will accept.
  assert.ok(JSON.stringify(stored).length < 8192,
            'siteProfiles would exceed chrome.storage.sync QUOTA_BYTES_PER_ITEM');
});

await test('remembered site choices stay under the cap', async () => {
  const { chrome, ctx } = loadBackground();
  const max = vm.runInContext('USER_CHOICES_MAX', ctx);
  const toggle = vm.runInContext('toggleSite', ctx);
  for (let i = 0; i < max + 20; i++) await toggle(`c${i}.example`);

  const stored = plain(chrome.storage.sync._dump().userChoices);
  assert.equal(Object.keys(stored).length, max);
  assert.ok(JSON.stringify(stored).length < 8192,
            'userChoices would exceed chrome.storage.sync QUOTA_BYTES_PER_ITEM');
});

await test('pruning never forgets that the user blocked a shipped default', async () => {
  const { chrome, ctx } = loadBackground();
  const max = vm.runInContext('USER_CHOICES_MAX', ctx);
  const toggle = vm.runInContext('toggleSite', ctx);

  // The user blocks YouTube — a shipped default — then visits many other sites.
  chrome.storage.sync.set({ allowlist: ['youtube.com'] });
  await toggle('youtube.com');
  assert.equal(plain(chrome.storage.sync._dump().userChoices)['youtube.com'], false);
  for (let i = 0; i < max + 20; i++) await toggle(`c${i}.example`);

  const choices = plain(chrome.storage.sync._dump().userChoices);
  assert.equal(choices['youtube.com'], false,
               'the decision to block a shipped default was pruned away');

  // And seeding must still honour it.
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  assert.ok(!plain(chrome.storage.sync._dump().allowlist).includes('youtube.com'),
            'a pruned choice let seeding re-add a site the user had blocked');
});

console.log('\nbackground.js — managed policy & auto-mode');

await test('an administrator policy overrides the user, key by key', async () => {
  const { ctx } = loadBackground();
  const merge = vm.runInContext('mergeSettings', ctx);
  const out = plain(merge({ ads: false, images: false, media: true }, { ads: true }, null));
  assert.equal(out.ads, true, 'policy did not win');
  assert.equal(out.images, false, 'policy touched a key it does not set');
  assert.deepEqual(out.managedKeys, ['ads']);
});

await test('auto-mode relaxes images on a fast connection, and nothing else', async () => {
  const { ctx } = loadBackground();
  const merge = vm.runInContext('mergeSettings', ctx);
  const user = { ads: true, images: true, media: true, autoMode: true };
  const fast = plain(merge(user, {}, { fast: true }));
  assert.equal(fast.images, false);
  assert.equal(fast.ads, true, 'auto-mode must not touch ads');
  assert.equal(fast.media, true, 'auto-mode must not touch video');
  const slow = plain(merge(user, {}, { fast: false }));
  assert.equal(slow.images, true);
});

await test('auto-mode does nothing unless the user switched it on', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('mergeSettings', ctx)(
    { ads: true, images: true, media: true, autoMode: false }, {}, { fast: true }));
  assert.equal(out.images, true);
});

await test('a policy that pins images beats auto-mode', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('mergeSettings', ctx)(
    { ads: true, images: true, media: true, autoMode: true }, { images: true }, { fast: true }));
  assert.equal(out.images, true, 'auto-mode overrode an enforced policy');
});

console.log('\nbackground.js — history');

await test('history accumulates into the right day', async () => {
  const { ctx } = loadBackground();
  const add = vm.runInContext('addToHistory', ctx);
  const now = Date.UTC(2026, 8, 15, 10);
  let h = add({}, { ads: 3, images: 4, media: 1 }, 500, now);
  h = plain(add(h, { ads: 1, images: 0, media: 0 }, 100, now));
  assert.deepEqual(h['2026-09-15'], { ads: 4, images: 4, media: 1, bytes: 600 });
});

await test('history keeps a rolling 60 days across a month boundary', async () => {
  const { ctx } = loadBackground();
  const add = vm.runInContext('addToHistory', ctx);
  let h = {};
  const start = Date.UTC(2026, 6, 1);
  for (let i = 0; i < 90; i++) h = add(h, { ads: 1 }, 1, start + i * 86400000);
  h = plain(h);
  const keys = Object.keys(h).sort();
  assert.equal(keys.length, 60);
  assert.equal(keys[keys.length - 1], '2026-09-28');
});

await test('site stats accumulate and stay capped', async () => {
  const { ctx } = loadBackground();
  const add = vm.runInContext('addToSiteStats', ctx);
  let st = add({}, 'a.test', { ads: 2, images: 3 }, 100);
  st = plain(add(st, 'a.test', { media: 1 }, 50));
  assert.deepEqual(st['a.test'], { n: 6, bytes: 150 });

  let big = {};
  for (let i = 0; i < 60; i++) big = add(big, `s${i}.test`, { ads: i + 1 }, 1);
  big = plain(big);
  assert.equal(Object.keys(big).length, 50);
  assert.ok(big['s59.test'], 'the busiest site was pruned');
  assert.ok(!big['s0.test'], 'the quietest site was kept');
});

await test('a page with no host is not recorded against a site', async () => {
  const { ctx } = loadBackground();
  const st = plain(vm.runInContext('addToSiteStats', ctx)({}, null, { ads: 5 }, 10));
  assert.deepEqual(st, {});
});

console.log('\nbackground.js — site history is opt-in');

await test('hostnames are NOT recorded by default', async () => {
  const { chrome, ctx } = loadBackground();
  // siteHistory unset — the default must be off, not merely absent.
  await vm.runInContext('recordBlocked', ctx)({ ads: 3, images: 2 }, 'private.example');
  const local = plain(chrome.storage.local._dump());
  assert.deepEqual(local.siteStats, {}, 'a hostname was recorded without consent');
  // The totals and the day bucket still work — only the site list is withheld.
  assert.equal(local.stats.ads, 3);
  assert.equal(Object.keys(local.history).length, 1);
});

await test('hostnames are recorded once the user opts in', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ siteHistory: true });
  await vm.runInContext('recordBlocked', ctx)({ ads: 3, images: 2 }, 'kept.example');
  assert.deepEqual(plain(chrome.storage.local._dump().siteStats), { 'kept.example': { n: 5, bytes: 3 * 30 * 1024 + 2 * 35 * 1024 } });
});

await test('switching site history off deletes what was already recorded', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.local.set({ siteStats: { 'old.example': { n: 9, bytes: 10 } } });
  for (const fn of chrome._listeners.changed) {
    fn({ siteHistory: { oldValue: true, newValue: false } }, 'sync');
  }
  await Promise.resolve();
  assert.deepEqual(plain(chrome.storage.local._dump().siteStats), {},
                   'the recorded sites survived the switch being turned off');
});

await test('turning site history ON does not wipe anything', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.local.set({ siteStats: { 'a.example': { n: 1, bytes: 1 } } });
  for (const fn of chrome._listeners.changed) {
    fn({ siteHistory: { oldValue: false, newValue: true } }, 'sync');
  }
  await Promise.resolve();
  assert.deepEqual(Object.keys(plain(chrome.storage.local._dump().siteStats)), ['a.example']);
});

console.log('\nbackground.js — data budget');

const GB = 1024;

function stageOn(ctx, over) {
  return plain(vm.runInContext('budgetStage', ctx)(Object.assign({
    budgetMB: 5 * GB, budgetResetDay: 1, budgetEase: null,
    now: new Date(2026, 8, 2).getTime()   // day 2 of a 30-day cycle
  }, over))).stage;
}

await test('a cycle is anchored to its reset day, not the 1st', async () => {
  const { ctx } = loadBackground();
  const info = plain(vm.runInContext('cycleInfo', ctx)(10, new Date(2026, 8, 12).getTime()));
  assert.equal(new Date(info.start).getDate(), 10);
  assert.equal(info.dayIndex, 3, 'the 12th is day 3 of a cycle starting on the 10th');
});

await test('a reset day past the 28th is clamped so February still works', async () => {
  const { ctx } = loadBackground();
  const info = plain(vm.runInContext('cycleInfo', ctx)(31, new Date(2026, 1, 10).getTime()));
  assert.equal(new Date(info.start).getDate(), 28);
});

await test('a smaller allowance starts the cycle stricter', async () => {
  const { ctx } = loadBackground();
  assert.equal(stageOn(ctx, { budgetMB: 500 }), 'tight');
  assert.equal(stageOn(ctx, { budgetMB: 2 * GB }), 'normal');
  assert.equal(stageOn(ctx, { budgetMB: 10 * GB }), 'relaxed');
});

await test('strictness escalates as the cycle runs down', async () => {
  const { ctx } = loadBackground();
  const at = (day) => stageOn(ctx, { budgetMB: 5 * GB, now: new Date(2026, 8, day).getTime() });
  assert.equal(at(2), 'relaxed');   // early
  assert.equal(at(17), 'normal');   // past halfway
  assert.equal(at(27), 'tight');    // past 80%
});

await test('a generous allowance never reaches the stage that trims the allowlist', async () => {
  const { ctx } = loadBackground();
  const late = stageOn(ctx, { budgetMB: 50 * GB, now: new Date(2026, 8, 29).getTime() });
  assert.equal(late, 'normal', 'a 50 GB plan should not be trimming video sites');
});

await test('easing off drops one stage, and expires with the cycle', async () => {
  const { ctx } = loadBackground();
  const now = new Date(2026, 8, 27).getTime();
  const cycle = plain(vm.runInContext('cycleInfo', ctx)(1, now));
  assert.equal(stageOn(ctx, { budgetMB: 5 * GB, now }), 'tight');
  assert.equal(stageOn(ctx, { budgetMB: 5 * GB, now, budgetEase: { cycleStart: cycle.start } }), 'normal');
  // An ease stamped for a DIFFERENT cycle must not carry over.
  assert.equal(stageOn(ctx, { budgetMB: 5 * GB, now, budgetEase: { cycleStart: cycle.start - 999999 } }), 'tight');
});

await test('the budget can only ever add blocking', async () => {
  const { ctx } = loadBackground();
  const apply = vm.runInContext('applyBudgetStage', ctx);
  const off = { ads: false, images: false, media: false };
  assert.deepEqual(plain(apply(off, 'relaxed')).ads, true);
  const tight = plain(apply(off, 'tight'));
  assert.equal(tight.ads, true); assert.equal(tight.images, true); assert.equal(tight.media, true);
  // 'relaxed' must not switch images or video on — that is what makes it relaxed.
  assert.equal(plain(apply(off, 'relaxed')).images, false);
});

await test('strict trims shipped defaults but keeps the user\'s own choices and calls', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('applyBudgetStage', ctx)({
    ads: true, images: true, media: true,
    allowlist: ['youtube.com', 'netflix.com', 'zoom.us', 'mysite.example'],
    userChoices: { 'mysite.example': true }   // the user explicitly allowed this
  }, 'strict'));
  assert.deepEqual(out.allowlist.sort(), ['mysite.example', 'zoom.us']);
});

await test('a call site is never trimmed, even at the strictest stage', async () => {
  const { ctx } = loadBackground();
  const calls = plain(vm.runInContext('CALL_SITES', ctx));
  const out = plain(vm.runInContext('applyBudgetStage', ctx)(
    { allowlist: calls.slice(), userChoices: {} }, 'strict'));
  assert.deepEqual(out.allowlist.sort(), calls.slice().sort());
});

await test('auto-mode outranks the budget on a fast connection', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('mergeSettings', ctx)(
    { ads: true, images: true, media: true, autoMode: true,
      budgetEnabled: true, budgetMB: 500, budgetResetDay: 1 },
    {}, { fast: true }, new Date(2026, 8, 27).getTime()));
  assert.equal(out.images, false, 'a fast connection is almost certainly not the metered link');
  assert.equal(out.media, true, 'auto-mode still must not touch video');
});

await test('an enforced policy outranks the budget', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('mergeSettings', ctx)(
    { ads: true, images: true, media: true, budgetEnabled: true, budgetMB: 500, budgetResetDay: 1 },
    { images: false }, null, new Date(2026, 8, 27).getTime()));
  assert.equal(out.images, false, 'the budget overrode an administrator policy');
});

await test('a disabled budget changes nothing', async () => {
  const { ctx } = loadBackground();
  const out = plain(vm.runInContext('mergeSettings', ctx)(
    { ads: false, images: false, media: false, budgetEnabled: false, budgetMB: 500 },
    {}, null, new Date(2026, 8, 27).getTime()));
  assert.deepEqual([out.ads, out.images, out.media], [false, false, false]);
  assert.equal(out.budgetStage, undefined);
});

await test('the stage is only re-applied when it actually moves', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ budgetEnabled: true, budgetMB: 500, budgetResetDay: 1 });
  const first = await vm.runInContext('ensureBudgetStage', ctx)(new Date(2026, 8, 2).getTime());
  assert.equal(first, 'tight');
  const again = await vm.runInContext('ensureBudgetStage', ctx)(new Date(2026, 8, 3).getTime());
  assert.equal(again, null, 'reconciled again despite the stage being unchanged');
  const moved = await vm.runInContext('ensureBudgetStage', ctx)(new Date(2026, 8, 27).getTime());
  assert.equal(moved, 'strict');
});

console.log('\nbackground.js — export / import');

await test('a round trip preserves what the user configured', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({
    ads: true, images: false, media: true,
    allowlist: ['youtube.com'], siteProfiles: { 'example.com': { images: false } }
  });
  const policy = plain(await vm.runInContext('exportPolicy', ctx)());
  assert.equal(policy.images, false);
  assert.deepEqual(policy.allowlist, ['youtube.com']);

  chrome.storage.sync._reset();
  await vm.runInContext('importPolicy', ctx)(policy);
  const back = plain(chrome.storage.sync._dump());
  assert.equal(back.images, false);
  assert.deepEqual(back.siteProfiles, { 'example.com': { images: false } });
});

await test('import drops junk instead of writing it to storage', async () => {
  const { chrome, ctx } = loadBackground();
  await vm.runInContext('importPolicy', ctx)({
    version: 1,
    images: false,
    evil: 'rm -rf',
    allowlist: ['ok.test', 'not a domain', 'javascript:alert(1)', 'http://x.test/path', 42],
    siteProfiles: { 'good.test': { images: false, nonsense: 1 }, 'bad domain': { images: false } }
  });
  const out = plain(chrome.storage.sync._dump());
  assert.equal(out.evil, undefined, 'an unrecognised key was written to storage');
  assert.deepEqual(out.allowlist, ['ok.test']);
  assert.deepEqual(out.siteProfiles, { 'good.test': { images: false } });
});

await test('import refuses a file it does not understand', async () => {
  const { ctx } = loadBackground();
  const imp = vm.runInContext('importPolicy', ctx);
  await assert.rejects(() => imp({ version: 99, images: false }), /unsupported version/);
  await assert.rejects(() => imp({ nothing: 'useful' }), /nothing recognisable/);
  await assert.rejects(() => imp('not an object'), /not an object/);
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
