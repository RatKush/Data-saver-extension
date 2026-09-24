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

function stopMedia(el) {
  stoppedMedia.add(el);
  try {
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
  const text = document.createElement('span');
  text.textContent = 'Data Saver stopped this video to save data.';
  const allow = document.createElement('button');
  allow.textContent = 'Play videos on this site';
  Object.assign(allow.style, { border: '0', borderRadius: '7px', padding: '6px 10px', font: '600 13px system-ui, sans-serif', background: '#3b82f6', color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap' });
  const close = document.createElement('button');
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Dismiss');
  Object.assign(close.style, { border: '0', background: 'transparent', color: '#aab4c5', cursor: 'pointer', font: '14px system-ui' });
  allow.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage(
        { type: 'ds-site-profile', hostname: location.hostname, profile: { media: false }, merge: true },
        () => { void chrome.runtime.lastError; location.reload(); }
      );
    } catch (e) { bar.remove(); }
  });
  close.addEventListener('click', () => bar.remove());
  bar.append(text, allow, close);
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
  if (!isMediaElement(e.target)) return;
  stopMedia(e.target);
  if (userJustActed()) showBlockedNotice();
}, true);

// A stopped element usually has no source left, so clicking it fires no 'play'
// at all — and custom players put an overlay on top, so the click target is
// not even the <video>. Look under the pointer instead.
document.addEventListener('click', (e) => {
  if (noticeShown || typeof document.elementsFromPoint !== 'function') return;
  const hit = document.elementsFromPoint(e.clientX, e.clientY)
    .some((el) => isMediaElement(el) && stoppedMedia.has(el));
  if (hit) showBlockedNotice();
}, true);

// --- Observe DOM changes for dynamically loaded media ---
const observer = new MutationObserver(mutations => {
  for (const m of mutations) {
    // New nodes: catch media (or containers holding media) inserted later.
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (isMediaElement(node)) stopMedia(node);
      else stopAllMedia(node);
      observeShadows(node);
    }
    // Attribute changes on existing elements: sites frequently reuse a
    // node and just swap src/autoplay instead of adding a new element.
    if (m.type === 'attributes' && isMediaElement(m.target)) {
      stopMedia(m.target);
    }
  }
});

observer.observe(document, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'autoplay']
});

// --- Observe Shadow DOMs too (for React/Vue/YouTube embeds) ---
function observeShadows(root = document) {
  root.querySelectorAll('*').forEach(el => {
    if (el.shadowRoot) {
      observer.observe(el.shadowRoot, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'autoplay']
      });
      stopAllMedia(el.shadowRoot);
    }
  });
}

// --- Initial execution ---
observeShadows();
stopAllMedia();
