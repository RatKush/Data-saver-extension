// -------------------------------------
// 📊 SAVINGS COUNTER
// Counts what actually got blocked on this page so the popup can show the
// user what they're getting. Everything here is observation only — this
// script never blocks anything itself and never changes the page.
//
// HOW IT COUNTS
// A subresource that Chrome refuses to load fires an 'error' event on the
// element that requested it. That event does not bubble, but it IS visible
// in the capture phase on document, which is the same mechanism
// hide_broken_images.js already relies on. One listener therefore sees
// every blocked <img>, <script>, <iframe>, <video>, <audio> and <source>
// regardless of when it was inserted.
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
// IFRAME is listed for completeness but rarely fires: Chromium renders a
// blocked frame as an error document inside the frame instead of firing
// 'error' on the element, so blocked ad iframes mostly go uncounted. Verified
// against Edge in scripts/e2e-edge.py — 3 blocked iframes produced 0 events.
// The meter therefore UNDERCOUNTS ad blocking, which is the right direction to
// be wrong in.
const BUCKET_BY_TAG = {
  IMG: 'images',
  SCRIPT: 'ads',
  IFRAME: 'ads',
  VIDEO: 'media',
  AUDIO: 'media',
  SOURCE: 'media',
  TRACK: 'media'
};

let pending = { ads: 0, images: 0, media: 0 };
let flushTimer = null;
let dead = false;

function hasCounts() {
  return pending.ads > 0 || pending.images > 0 || pending.media > 0;
}

function flush() {
  flushTimer = null;
  if (dead || !hasCounts()) return;

  const payload = pending;
  pending = { ads: 0, images: 0, media: 0 };

  try {
    chrome.runtime.sendMessage({ type: 'ds-blocked', counts: payload }, () => {
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
  if (dead || flushTimer !== null) return;
  flushTimer = setTimeout(flush, 3000);
}

document.addEventListener('error', (e) => {
  const target = e.target;
  if (!target || target.nodeType !== 1) return;

  const bucket = BUCKET_BY_TAG[target.tagName];
  if (!bucket) return;

  // An element with no source never made a request, so its failure isn't a
  // block — skip it rather than inflate the count.
  if (!target.src && !target.getAttribute?.('src')) return;

  pending[bucket]++;
  scheduleFlush();
}, true);

// A page that is closed or backgrounded before the 3s timer fires would
// otherwise lose its tail. 'pagehide' fires for both navigation and bfcache,
// which 'unload' does not.
window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});
