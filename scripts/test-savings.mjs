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
  const ctx = vm.createContext({
    chrome, console: { log() {}, warn() {} }, setTimeout, clearTimeout, Date, URL
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

await test('a fresh install ships with youtube.com unblocked', async () => {
  const { chrome, ctx } = loadBackground();
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  const { allowlist, defaultsSeeded } = chrome.storage.sync._dump();
  assert.deepEqual(plain(allowlist), ['youtube.com']);
  assert.equal(defaultsSeeded, true);
});

await test('seeding preserves a user\'s existing allowlist', async () => {
  const { chrome, ctx } = loadBackground();
  chrome.storage.sync.set({ allowlist: ['mysite.example'] });
  await vm.runInContext('seedDefaultAllowlist', ctx)();
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist).sort(),
                   ['mysite.example', 'youtube.com']);
});

await test('seeding runs once — resuming on YouTube sticks', async () => {
  const { chrome, ctx } = loadBackground();
  const seed = vm.runInContext('seedDefaultAllowlist', ctx);
  await seed();

  // User resumes blocking on YouTube.
  await vm.runInContext('toggleSite', ctx)('www.youtube.com');
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), []);

  // A later browser restart must not quietly put it back.
  await seed();
  assert.deepEqual(plain(chrome.storage.sync._dump().allowlist), [],
                   'youtube.com came back after the user removed it');
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
  c.fire('SCRIPT'); c.fire('IFRAME');
  c.fire('VIDEO'); c.fire('AUDIO'); c.fire('SOURCE');
  c.flush();
  assert.equal(c.sent.length, 1, 'should batch into a single message');
  assert.deepEqual(plain(c.sent[0].counts), { ads: 2, images: 2, media: 3 });
});

await test('ignores element types we do not block', async () => {
  const c = loadCounter();
  c.fire('LINK'); c.fire('DIV'); c.fire('OBJECT');
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
