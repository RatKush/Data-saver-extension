// -------------------------------------
// 🚫 STOP ALL MEDIA (Aggressive Mode)
// Covers <video> and <audio>. Network-level DNR rules (rules/media.json)
// stop most bytes before they arrive; this content script is the
// behavioral backstop for whatever reaches the DOM anyway (same-origin
// media, blob:/MediaSource-backed players, elements present before the
// DNR rules could apply, etc.).
// -------------------------------------

// Every element this script has stopped, so a later click on it can be
// recognised as "the user wanted this to play".
const stoppedMedia = new WeakSet();

// What was taken off each element, so "Play on this page" can put it back
// without a reload. Held weakly: a removed element takes its record with it.
const originals = new WeakMap();
const stoppedRefs = [];

// Set once this tab has been allowed to play video (background.js
// allowMediaOnce). Asked for at load as well as set by the button, because a
// player that had already given up needs a reload, and the reloaded page has
// to know not to stop it again.
let playAllowed = false;

function remember(el) {
  const src = el.getAttribute('src');
  const sources = [...el.querySelectorAll('source')];
  // A site that reuses the element sets a new source on it; keep the latest
  // real one rather than the empty state this script left behind.
  if (originals.has(el) && !src && !sources.length) return;
  if (!originals.has(el) && typeof WeakRef === 'function') stoppedRefs.push(new WeakRef(el));
  originals.set(el, {
    src,
    sources: sources.map((s) => s.cloneNode(true)),
    autoplay: el.hasAttribute('autoplay')
  });
}

// Put back what stopMedia took. Returns false when there was nothing to put
// back — a MediaSource player (blob: src) or one that sets its source from
// script, which only a reload can restart.
function restore(el) {
  const o = originals.get(el);
  if (!o || (!o.src && !o.sources.length) || /^blob:/i.test(o.src || '')) return false;
  try {
    if (o.src) el.setAttribute('src', o.src);
    for (const s of o.sources) el.appendChild(s.cloneNode(true));
    el.removeAttribute('preload');
    el.preload = 'auto';
    el.load();
    return true;
  } catch (e) {
    return false;
  }
}

function allowPlaybackHere() {
  playAllowed = true;
  try { observer.disconnect(); } catch (e) { /* not started */ }
  let restartable = true;
  for (const ref of stoppedRefs) {
    const el = ref.deref();
    if (el && el.isConnected && !restore(el)) restartable = false;
  }
  return restartable;
}

function stopMedia(el) {
  if (playAllowed) return;
  stoppedMedia.add(el);
  try {
    remember(el);
    // Immediately pause any playback
    if (!el.paused) el.pause();

    // Prevent autoplay and stop the browser from pre-buffering data for
    // media the user hasn't asked to play yet — this is what closes the
    // gap between "element appears" and "we noticed and reacted".
    el.removeAttribute('autoplay');
    el.autoplay = false;
    el.muted = true;
    el.setAttribute('preload', 'none');
    el.preload = 'none';

    // Remove sources and stop downloading data. Only touch what is actually
    // there, and never write `src = ''`: that ADDS a src attribute, the
    // MutationObserver below sees it and calls stopMedia again, an empty src
    // then reads back as the page URL so the attribute is removed again, and
    // the two ping-pong forever — the tab sat at 100% CPU until it was closed
    // (pressing play on any <video>, and some news sites on plain page load).
    let changed = false;
    if (el.hasAttribute('src')) { el.removeAttribute('src'); changed = true; }
    for (const source of el.querySelectorAll('source')) { source.remove(); changed = true; }
    if (changed && el.load) el.load();
  } catch (e) {
    // Silently ignore any cross-origin media errors
  }
}

// --- Tell the user why their video did not play ------------------------
// A press of play that silently does nothing reads as a broken site. When the
// stop follows a real user action, say what happened once per page and offer
// the one-click way out: a site profile that stops blocking video here.
let noticeShown = false;

const say = (key, fallback) => {
  try { return chrome.i18n.getMessage(key) || fallback; } catch (e) { return fallback; }
};

function showBlockedNotice() {
  if (noticeShown || window.top !== window) return;
  noticeShown = true;
  const bar = document.createElement('div');
  bar.setAttribute('role', 'status');
  Object.assign(bar.style, {
    position: 'fixed', left: '50%', bottom: '24px', transform: 'translateX(-50%)', zIndex: '2147483647',
    display: 'flex', gap: '12px', alignItems: 'center', maxWidth: 'min(92vw, 560px)', padding: '10px 14px',
    borderRadius: '10px', background: '#1d2433', color: '#f2f5fa', font: '14px/1.4 system-ui, sans-serif',
    boxShadow: '0 8px 28px rgba(0,0,0,.35)'
  });
  bar.style.flexWrap = 'wrap';
  const text = document.createElement('span');
  text.textContent = say('videoStopped', 'Data Saver stopped this video to save data.');
  // The one-off comes first: it is the smaller change, and the one that
  // does not quietly turn a data saver off for a whole site.
  const once = document.createElement('button');
  once.textContent = say('videoPlayPage', 'Play on this page');
  Object.assign(once.style, { border: '0', borderRadius: '7px', padding: '6px 10px', font: '600 13px system-ui, sans-serif', background: '#3b82f6', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' });
  const allow = document.createElement('button');
  allow.textContent = say('videoPlaySite', 'Always on this site');
  Object.assign(allow.style, { border: '1px solid #4b5568', borderRadius: '7px', padding: '5px 10px', font: '600 13px system-ui, sans-serif', background: 'transparent', color: '#f2f5fa', cursor: 'pointer', whiteSpace: 'nowrap' });
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', say('dismiss', 'Dismiss'));
  Object.assign(close.style, { border: '0', background: 'transparent', color: '#aab4c5', cursor: 'pointer', font: '14px system-ui' });
  once.addEventListener('click', () => {
    once.disabled = allow.disabled = true;
    try {
      chrome.runtime.sendMessage({ type: 'ds-media-once' }, (res) => {
        void chrome.runtime.lastError;
        if (!res || !res.ok) { once.disabled = allow.disabled = false; return; }
        // A plain <video src> can simply be given its source back. A player
        // that streams through MediaSource already gave up when its first
        // segment was blocked, and only a fresh page load restarts it — the
        // tab's allowance survives that reload (see ds-media-state below).
        if (allowPlaybackHere()) {
          bar.remove();
          if (lastClicked && lastClicked.play) lastClicked.play().catch(() => {});
        } else {
          location.reload();
        }
      });
    } catch (e) { bar.remove(); }
  });
  allow.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage(
        { type: 'ds-site-profile', hostname: location.hostname, profile: { media: false }, merge: true },
        () => { void chrome.runtime.lastError; location.reload(); }
      );
    } catch (e) { bar.remove(); }
  });
  close.addEventListener('click', () => bar.remove());
  bar.append(text, once, allow, close);
  document.documentElement.appendChild(bar);
  setTimeout(() => bar.remove(), 12000);
}

function userJustActed() {
  try { return !!(navigator.userActivation && navigator.userActivation.isActive); } catch (e) { return false; }
}

function isMediaElement(node) {
  return node instanceof HTMLVideoElement || node instanceof HTMLAudioElement;
}

function stopAllMedia(root = document) {
  const elements = root.querySelectorAll('video, audio');
  for (const el of elements) stopMedia(el);
}

// --- Catch playback directly, not just attribute state ---
// Custom players and SPA re-renders often reuse an *existing* element and
// just call .play()/reassign .src on it instead of inserting a new node.
// A MutationObserver watching childList/subtree alone never sees that, so
// playback continues. Listening for the 'play' event in the capture phase
// catches every playback attempt regardless of how the element got its
// source, including elements that existed before this script ran.
document.addEventListener('play', (e) => {
  if (playAllowed || !isMediaElement(e.target)) return;
  stopMedia(e.target);
  if (userJustActed()) { lastClicked = e.target; showBlockedNotice(); }
}, true);

// A stopped element usually has no source left, so clicking it fires no 'play'
// at all — and custom players put an overlay on top, so the click target is
// not even the <video>. Look under the pointer instead.
let lastClicked = null;

document.addEventListener('click', (e) => {
  if (playAllowed || typeof document.elementsFromPoint !== 'function') return;
  const hit = document.elementsFromPoint(e.clientX, e.clientY)
    .find((el) => isMediaElement(el) && stoppedMedia.has(el));
  if (!hit) return;
  lastClicked = hit;
  showBlockedNotice();
}, true);

// --- Observe DOM changes for dynamically loaded media ---
// One batch of records often holds a node AND its own descendants: while a
// page is parsed, every element is its own record, and by the time this runs
// each one's subtree is already filled in. Scanning every record's subtree
// then visits a node once per ancestor in the batch, which on a long page or
// an infinite feed is what made pages feel slow. Only the topmost added nodes
// of a batch are scanned, so each new node is visited once.
const observer = new MutationObserver(mutations => {
  const added = new Set();
  for (const m of mutations) {
    // New nodes: catch media (or containers holding media) inserted later.
    for (const node of m.addedNodes) {
      if (node.nodeType === 1) added.add(node);
    }
    // Attribute changes on existing elements: sites frequently reuse a
    // node and just swap src/autoplay instead of adding a new element.
    if (m.type === 'attributes' && isMediaElement(m.target)) {
      stopMedia(m.target);
    }
  }
  for (const node of added) {
    if (hasAddedAncestor(node, added)) continue;
    if (isMediaElement(node)) stopMedia(node);
    else stopAllMedia(node);
    observeShadows(node);
  }
});

function hasAddedAncestor(node, added) {
  for (let p = node.parentNode; p; p = p.parentNode) {
    if (added.has(p)) return true;
  }
  return false;
}

observer.observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'autoplay']
});

// --- Observe Shadow DOMs too (for React/Vue/YouTube embeds) ---
// A shadow root is watched once. Without this, every re-render that re-adds
// a host re-attached the observer and re-scanned the same root.
const watchedShadows = new WeakSet();

function observeShadows(root = document) {
  // An added node can itself be a host, which querySelectorAll('*') skips.
  if (root.nodeType === 1) watchShadow(root);
  for (const el of root.querySelectorAll('*')) watchShadow(el);
}

function watchShadow(el) {
  const shadow = el.shadowRoot;
  if (!shadow || watchedShadows.has(shadow)) return;
  watchedShadows.add(shadow);
  observer.observe(shadow, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'autoplay']
  });
  stopAllMedia(shadow);
  // Players nest web components, so a root can hold further roots.
  observeShadows(shadow);
}

// --- Initial execution ---
observeShadows();
stopAllMedia();

// Was this tab already allowed to play video ("Play on this page", then the
// reload a streaming player needs)? The answer arrives within milliseconds —
// before a player's own scripts have usually even loaded — and anything
// stopped in that gap is put back.
try {
  chrome.runtime.sendMessage({ type: 'ds-media-state' }, (res) => {
    void chrome.runtime.lastError;
    if (res && res.allowed) allowPlaybackHere();
  });
} catch (e) { /* extension context gone */ }
