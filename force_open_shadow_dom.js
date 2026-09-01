// -------------------------------------
// 🔓 FORCE OPEN SHADOW DOM (MAIN world)
// -------------------------------------
// Runs in the page's own JS context (not the isolated content-script world)
// so it can patch Element.prototype before any page script runs.
//
// A page/widget can call attachShadow({mode: 'closed'}) to make its shadow
// root completely unreachable — not just via element.shadowRoot, but from
// ANY script on the page, including our isolated-world content scripts
// (stop_all_media.js). That's a real evasion path for video players or ad
// wrappers implemented as web components. Forcing mode to 'open' makes
// element.shadowRoot resolve normally, so the existing content-script
// traversal picks these up with no other changes needed.
//
// ⚠️ SECURITY TRADE-OFF: this weakens shadow DOM encapsulation site-wide,
// not just for media/ad wrappers. ANY script or extension on the page can
// now read what the site intended to be closed — including, in principle,
// security- or privacy-sensitive widgets (payment forms, embedded auth
// widgets, some CAPTCHAs) that rely on closed mode. It's tied to the
// "Block Videos" toggle: turn that off on pages where you don't want this
// active.
(function () {
  if (typeof Element === 'undefined' || !Element.prototype.attachShadow) return;
  if (Element.prototype.attachShadow.__dataSaverPatched) return; // already patched (e.g. re-injected)

  const originalAttachShadow = Element.prototype.attachShadow;

  function patchedAttachShadow(init) {
    const forcedInit = init && typeof init === 'object' ? { ...init, mode: 'open' } : { mode: 'open' };
    return originalAttachShadow.call(this, forcedInit);
  }

  patchedAttachShadow.__dataSaverPatched = true;
  Element.prototype.attachShadow = patchedAttachShadow;
})();
