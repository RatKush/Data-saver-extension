// -------------------------------------
// 🖼️ BLOCKED-IMAGE PLACEHOLDERS
// Runs wherever image blocking is on. Two jobs:
//
//  1. Collapse genuinely failed images so they do not leave broken-icon boxes.
//     (Since 2.4 our own blocked images are REDIRECTED to a 1x1 blank.gif and
//     load rather than fail, so this now only catches images that failed for
//     some other reason.)
//
//  2. Make our blanked images look deliberate and loadable one at a time. A
//     blanked image keeps the page's layout but is empty, which reads as
//     "this site is broken". It gets a faint tint and an outline instead, and
//     hovering it shows a "Load image" button that loads just that image —
//     the smallest way out, short of unblocking images on the whole site.
//
// Loading goes through background.js (allowImageOnce): it sets up a one-off
// URL for this one image in this tab, and the page loads it as an ordinary
// <img>. The extension never fetches the image itself.
// -------------------------------------
//
// Wrapped in its own scope: every content script that runs in the isolated
// world shares ONE global scope, so a top-level `const say` here and another
// in stop_all_media.js made whichever loaded second throw on its first line
// (and `pending` collides with savings_counter.js the same way).
(() => {

function collapseImage(img) {
  try {
    img.style.setProperty('display', 'none', 'important');
  } catch (e) {
    // Ignore — never let cleanup styling throw and break the page.
  }
}

// 'error' fires on the <img> element itself and does NOT bubble, but it is
// still observable in the capture phase on an ancestor (document), so a
// single listener catches every image load failure regardless of when the
// element was inserted — no MutationObserver needed for this.
document.addEventListener('error', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLImageElement)) return;
  // One we are loading on request is shown as failed, not hidden, so the
  // user sees that the click did something.
  if (loading.has(target)) return;
  collapseImage(target);
}, true);

// Images that failed before this script attached (rare, but possible for
// elements parsed very early) won't fire a fresh 'error' event. Sweep once
// for any <img> that's already in a broken state.
function sweepBrokenImages(root = document) {
  root.querySelectorAll('img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0 && img.src) collapseImage(img);
  });
}

sweepBrokenImages();

// --- Placeholders --------------------------------------------------------
// Only images big enough to be content get one. Below this they are icons,
// spacers and tracking pixels, and a button on each would be noise.
const MIN_W = 48;
const MIN_H = 32;

const say = (key, fallback) => {
  try { return chrome.i18n.getMessage(key) || fallback; } catch (e) { return fallback; }
};

const placeholders = new WeakSet();
const loading = new WeakSet();
const saved = new WeakMap();   // img -> the inline styles we replaced

// The same test the savings counter uses: a 1x1 result from a real http(s)
// source is blank.gif standing in for a blocked image.
function isBlanked(img) {
  return img.complete && img.naturalWidth === 1 && img.naturalHeight === 1
    && /^https?:/i.test(img.currentSrc || img.src || '');
}

// The icon is drawn in the element's own text colour at low opacity, via a
// data: SVG, so it reads on light and dark sites without guessing which.
const ICON = 'url("data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="gray" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round" opacity="0.7"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/>'
  + '<circle cx="8.5" cy="10" r="1.6"/><path d="M3.5 16.5l4.7-4.2a2 2 0 0 1 2.7.05L15 16.5"/>'
  + '<path d="M14 14.2l1.9-1.7a2 2 0 0 1 2.7.06l1.9 1.8"/></svg>') + '")';

function markPlaceholder(img) {
  if (placeholders.has(img) || loading.has(img)) return;
  const r = img.getBoundingClientRect();
  if (r.width < MIN_W || r.height < MIN_H) return;
  placeholders.add(img);
  // Paint only: background and outline change no layout, so the page keeps
  // exactly the shape it had. The site's own inline values are kept to put
  // back once the image loads.
  saved.set(img, {
    background: img.style.getPropertyValue('background'),
    outline: img.style.getPropertyValue('outline'),
    outlineOffset: img.style.getPropertyValue('outline-offset')
  });
  img.style.setProperty('background',
    `${ICON} center / ${Math.min(28, Math.max(16, Math.round(r.height / 4)))}px no-repeat, rgba(128,128,128,0.10)`);
  img.style.setProperty('outline', '1px dashed rgba(128,128,128,0.45)');
  img.style.setProperty('outline-offset', '-1px');
}

function unmark(img) {
  placeholders.delete(img);
  const s = saved.get(img);
  saved.delete(img);
  if (!s) return;
  const put = (prop, value) => (value ? img.style.setProperty(prop, value) : img.style.removeProperty(prop));
  put('background', s.background);
  put('outline', s.outline);
  put('outline-offset', s.outlineOffset);
}

document.addEventListener('load', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement)) return;
  if (isBlanked(img)) {
    // Layout may not be final at load time; one frame later it usually is.
    requestAnimationFrame(() => markPlaceholder(img));
  } else if (placeholders.has(img)) {
    // The site swapped in a source that did load (an allowed host, a data:
    // URL). It is not a placeholder any more.
    unmark(img);
  }
}, true);

// Images that finished before this script attached.
function sweepPlaceholders() {
  for (const img of document.images) if (isBlanked(img)) markPlaceholder(img);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sweepPlaceholders, { once: true });
} else {
  sweepPlaceholders();
}

// --- The button ----------------------------------------------------------
// One button per frame, moved to whichever placeholder is under the pointer.
// It lives in a closed shadow root so the site's CSS cannot restyle it and
// its own styles cannot leak into the site.
let host = null;
let button = null;
let current = null;

function ensureButton() {
  if (button) return button;
  host = document.createElement('data-saver-load');
  Object.assign(host.style, {
    position: 'fixed', zIndex: '2147483647', top: '0', left: '0', display: 'none', pointerEvents: 'auto'
  });
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    button {
      all: initial; box-sizing: border-box; display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-radius: 8px; cursor: pointer; white-space: nowrap;
      font: 600 12.5px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif;
      background: #1d2433; color: #f2f5fa; box-shadow: 0 4px 16px rgba(0,0,0,.3);
    }
    button:hover { background: #2b3548; }
    button:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
    button[disabled] { opacity: .75; cursor: progress; }`;
  button = document.createElement('button');
  button.type = 'button';
  root.append(style, button);
  // Pressing it must not click whatever the image sits inside — most
  // images on news and shop pages are links. The load happens in the SAME
  // listener that stops the event: stopping propagation in a capture
  // listener at the target also skips that target's own bubble listeners in
  // current Chrome, so a separate click handler never ran.
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
    button.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (type === 'click' && current) loadOne(current);
    }, true);
  }
  (document.body || document.documentElement).appendChild(host);
  return button;
}

function place(img) {
  const b = ensureButton();
  const r = img.getBoundingClientRect();
  current = img;
  b.disabled = loading.has(img);
  b.textContent = b.disabled ? say('imgLoading', 'Loading…') : say('imgLoad', 'Load image');
  host.style.left = `${Math.round(Math.max(r.left, 0) + 8)}px`;
  host.style.top = `${Math.round(Math.max(r.top, 0) + 8)}px`;
  host.style.display = 'block';
}

function hide() {
  if (host) host.style.display = 'none';
  current = null;
}

function placeholderAt(x, y) {
  if (typeof document.elementsFromPoint !== 'function') return null;
  // Look under overlays too: image cards commonly put a gradient or a link
  // box on top of the <img>, so the pointer is never over the image itself.
  for (const el of document.elementsFromPoint(x, y)) {
    if (el === host) return current;
    if (el instanceof HTMLImageElement && placeholders.has(el)) return el;
  }
  return null;
}

let pending = false;
document.addEventListener('pointermove', (e) => {
  if (pending || e.pointerType === 'touch') return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const img = placeholderAt(e.clientX, e.clientY);
    if (img && img !== current) place(img);
    else if (!img && current) hide();
  });
}, { passive: true, capture: true });

// A scroll moves the image out from under a fixed-position button.
window.addEventListener('scroll', hide, { passive: true, capture: true });

function loadOne(img) {
  const url = img.currentSrc || img.src;
  if (!url || loading.has(img)) return;
  loading.add(img);
  if (button) { button.disabled = true; button.textContent = say('imgLoading', 'Loading…'); }

  try {
    chrome.runtime.sendMessage({ type: 'ds-load-image', url }, (res) => {
      void chrome.runtime.lastError;
      if (!res || !res.ok) { failed(img); return; }
      swap(img, res.url, res.ids);
    });
  } catch (e) {
    failed(img);   // extension reloaded underneath the page
  }
}

function swap(img, onceUrl, ids) {
  const done = (ok) => {
    loading.delete(img);
    try { chrome.runtime.sendMessage({ type: 'ds-load-image-done', ids }, () => void chrome.runtime.lastError); } catch (e) { /* gone */ }
    if (ok) { unmark(img); if (current === img) hide(); } else failed(img);
  };
  img.addEventListener('load', () => done(img.naturalWidth > 1 || img.naturalHeight > 1), { once: true });
  img.addEventListener('error', () => done(false), { once: true });

  // srcset and <picture> sources outrank src, so they go: the URL being
  // loaded is the one the browser had already picked for this size.
  const picture = img.parentElement && img.parentElement.tagName === 'PICTURE' ? img.parentElement : null;
  if (picture) for (const source of picture.querySelectorAll('source')) source.remove();
  img.removeAttribute('srcset');
  img.removeAttribute('sizes');
  img.loading = 'eager';
  img.src = onceUrl;
}

function failed(img) {
  loading.delete(img);
  if (current === img && button) {
    button.disabled = false;
    button.textContent = say('imgFailed', "Couldn't load — try again");
  }
}

})();
