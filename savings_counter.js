// -------------------------------------
// 📊 SAVINGS COUNTER
// Counts what actually got blocked on this page so the popup can show the
// user what they're getting. Everything here is observation only — this
// script never blocks anything itself and never changes the page.
//
// HOW IT COUNTS
// Most blocked subresources fire an 'error' event on the element that
// requested them. That event does not bubble, but it IS visible in the capture
// phase on document, which is the same mechanism hide_broken_images.js already
// relies on. One listener therefore sees every blocked <img>, <object>,
// <script>, <video>, <audio> and <source> regardless of when it was inserted.
// Frames are the exception and are handled separately at the bottom.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// Chrome offers no production API for "how many bytes did declarativeNetRequest
// save me" — getMatchedRules() needs the declarativeNetRequestFeedback
// permission (a new install-time warning, for a 5-minute rolling window), and
// onRuleMatchedDebug only exists for unpacked extensions. So counts are
// DOM-observed and byte totals are estimates. The popup says so.
// -------------------------------------

// Requests that fail for reasons that have nothing to do with us (a genuinely
// dead image on a site, a flaky CDN) land in these counts too. That is why the
// byte constants in background.js are deliberately conservative and the popup
// labels the total as an estimate rather than a measurement.
//
// WHAT FIRES WHAT, measured against Edge with this extension loaded rather
// than assumed (see scripts/probe-events.py):
//   OBJECT, SCRIPT        fire 'error'  -> counted here
//   IMG                   since 2.4 blocked images are REDIRECTED to a 1x1
//                         blank.gif (a failed image made Chrome re-request it
//                         tens of thousands of times a minute on some sites),
//                         so they fire 'load' with a 1x1 natural size and are
//                         counted in the load listener below
//   IFRAME                fires 'load'  -> handled separately below
//   EMBED                 fires NOTHING -> cannot be counted at all
const BUCKET_BY_TAG = {
  IMG: 'images',
  SCRIPT: 'ads',
  OBJECT: 'ads',
  VIDEO: 'media',
  AUDIO: 'media',
  SOURCE: 'media',
  TRACK: 'media'
};

let pending = { ads: 0, images: 0, media: 0 };

// Hard ceiling per page. A site retry loop can fire the same element's events
// thousands of times; one visit must never add "gigabytes saved" to the meter.
const MAX_PER_PAGE = 1500;
let countedThisPage = 0;

// Redirected images only count where image blocking is actually on for this
// page: the script is excluded from paused sites, but a site profile can switch
// images back on while ads or video stay blocked.
let countImages = false;
try {
  chrome.storage.sync.get({ images: true, siteProfiles: {} }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    const host = location.hostname;
    const key = Object.keys(data.siteProfiles || {}).find((d) => host === d || host.endsWith('.' + d));
    const profile = key ? data.siteProfiles[key] : null;
    countImages = data.images !== false && !(profile && profile.images === false);
  });
} catch (e) { /* extension context gone */ }
const countedImages = new WeakSet();
let pendingFrames = [];
let flushTimer = null;
let dead = false;

function hasCounts() {
  return pending.ads > 0 || pending.images > 0 || pending.media > 0 || pendingFrames.length > 0;
}

function flush() {
  flushTimer = null;
  if (dead || !hasCounts()) return;

  const payload = pending;
  const frames = pendingFrames;
  pending = { ads: 0, images: 0, media: 0 };
  pendingFrames = [];

  try {
    chrome.runtime.sendMessage({ type: 'ds-blocked', counts: payload, frames }, () => {
      // The service worker may be asleep or the extension may have been
      // reloaded/updated underneath us. Reading lastError marks it handled so
      // Chrome doesn't log "Unchecked runtime.lastError" on every page.
      if (chrome.runtime.lastError) dead = true;
    });
  } catch (e) {
    // Extension context invalidated (update or disable while the page is
    // open). Stop trying; this page's remaining counts are not worth a
    // stream of console noise.
    dead = true;
  }
}

// Batch rather than messaging per blocked request: an image-heavy page can
// block hundreds of requests in a second, and one sendMessage per request
// would cost more than the blocking saves.
function scheduleFlush() {
  countedThisPage++;
  if (dead || flushTimer !== null) return;
  flushTimer = setTimeout(flush, 3000);
}

document.addEventListener('error', (e) => {
  const target = e.target;
  if (!target || target.nodeType !== 1) return;

  const bucket = BUCKET_BY_TAG[target.tagName];
  if (!bucket || countedThisPage >= MAX_PER_PAGE) return;
  // A failed <img> is no longer ours (ours redirect and load) — it is a
  // genuinely broken image on the site, and counting it inflated the meter.
  if (target.tagName === 'IMG') return;

  // An element with no source never made a request, so its failure isn't a
  // block — skip it rather than inflate the count.
  if (!target.src && !target.getAttribute?.('src')) return;

  pending[bucket]++;
  scheduleFlush();
}, true);

// --- Frames ---------------------------------------------------------------
// A blocked frame fires 'load', not 'error': Chromium replaces it with an error
// document rather than failing the element. From in here a blocked frame and a
// real cross-origin frame are indistinguishable — contentDocument is null and
// location throws for both — so guessing would mean inflating the meter, which
// is worse than undercounting it.
//
// Instead the frame's hostname goes to background.js, which holds the actual
// blocklist and the allowlist and can answer definitively. Frames are orders of
// magnitude rarer than images, so one lookup per frame is cheap.
// Ad networks routinely place several frames from the SAME host on one page, so
// these are counted per frame rather than per hostname — deduping by host here
// undercounted a fixture with three googlesyndication frames as one. Capped so
// a pathological page cannot grow the batch without bound.
const MAX_FRAMES_PER_BATCH = 200;

document.addEventListener('load', (e) => {
  const el = e.target;
  if (el && el.tagName === 'IMG') {
    // A 1x1 result from a real http(s) source is our blank.gif standing in for
    // a blocked image. Counted once per element, however often a lazy-loader
    // re-triggers it.
    if (!countImages || countedThisPage >= MAX_PER_PAGE || countedImages.has(el)) return;
    if (el.naturalWidth !== 1 || el.naturalHeight !== 1) return;
    if (!/^https?:/i.test(el.currentSrc || el.src || '')) return;
    countedImages.add(el);
    pending.images++;
    scheduleFlush();
    return;
  }
  if (!el || el.tagName !== 'IFRAME') return;

  const src = el.src || el.getAttribute('src');
  if (!src) return;

  let host;
  try {
    host = new URL(src, location.href).hostname;
  } catch (err) {
    return;
  }
  // Same-origin frames are never ad frames, and we would only be asking about
  // the page the user is already on.
  if (!host || host === location.hostname) return;

  if (pendingFrames.length >= MAX_FRAMES_PER_BATCH) return;

  pendingFrames.push(host);
  scheduleFlush();
}, true);

// A page that is closed or backgrounded before the 3s timer fires would
// otherwise lose its tail. 'pagehide' fires for both navigation and bfcache,
// which 'unload' does not.
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
