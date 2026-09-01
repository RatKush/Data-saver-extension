// -------------------------------------
// 🚫 STOP ALL MEDIA (Aggressive Mode)
// Covers <video> and <audio>. Network-level DNR rules (rules/media.json)
// stop most bytes before they arrive; this content script is the
// behavioral backstop for whatever reaches the DOM anyway (same-origin
// media, blob:/MediaSource-backed players, elements present before the
// DNR rules could apply, etc.).
// -------------------------------------

function stopMedia(el) {
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

    // Remove sources and stop downloading data
    if (el.src) el.removeAttribute('src');
    if (el.currentSrc) el.src = '';
    if (el.load) el.load();
  } catch (e) {
    // Silently ignore any cross-origin media errors
  }
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
  if (isMediaElement(e.target)) stopMedia(e.target);
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
