// -------------------------------------
// 🚪 POPUP BLOCKER  (premium, off by default)
//
// Runs in the MAIN world because window.open has to be replaced on the page's
// own window object — the same reason force_open_shadow_dom.js runs there.
// MAIN-world scripts have NO extension API access, so this script cannot read
// settings or report what it blocked. Registration is the gate: background.js
// only injects it when the feature is on and the site is not paused.
//
// THE RULE: a popup opened while the user is actually interacting is wanted;
// one opened on a timer, on page load, or from an ad frame is not.
// navigator.userActivation.isActive is exactly that distinction, and it stays
// true for a few seconds after a real click, so the common legitimate pattern
// — open a window from a callback shortly after a click — still works.
//
// Returning null is what a browser's own popup blocker returns, so sites that
// check the result already handle it. Throwing would break them.
// -------------------------------------
(function () {
  'use strict';

  const nativeOpen = window.open;
  if (typeof nativeOpen !== 'function') return;

  function userIsActive() {
    try {
      // Older Chromium has no userActivation. Fail OPEN rather than closed:
      // wrongly blocking a window the user asked for is far more damaging
      // than letting one through.
      if (!navigator.userActivation) return true;
      return navigator.userActivation.isActive === true;
    } catch (e) {
      return true;
    }
  }

  function open(...args) {
    if (userIsActive()) return nativeOpen.apply(window, args);
    return null;
  }

  // Sites fingerprint window.open by stringifying it; a plain function body
  // gives the override away and some scripts then take a different path.
  try {
    Object.defineProperty(open, 'name', { value: 'open', configurable: true });
    open.toString = () => 'function open() { [native code] }';
  } catch (e) { /* non-fatal — the override still works */ }

  try {
    Object.defineProperty(window, 'open', {
      value: open,
      writable: true,
      configurable: true
    });
  } catch (e) {
    // A page that has already frozen window.open keeps its own. Nothing to do.
  }
})();
