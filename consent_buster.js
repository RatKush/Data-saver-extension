// -------------------------------------
// 🍪 CONSENT HANDLER  (premium, off by default)
//
// Cookie walls cost real bandwidth — a consent platform is typically a few
// hundred KB of third-party JavaScript — but the reason this exists is the
// user's instruction: when a banner can only be dismissed by pressing
// something, press the option that preserves the most privacy.
//
// THE ONE RULE THIS SCRIPT WILL NOT BREAK: it never presses Accept.
// Rejecting is a real choice recorded on the user's behalf, and it is the
// choice they asked for. Accepting on their behalf would be the opposite, so
// when no reject path can be found with confidence this script hides the
// banner and records nothing rather than guessing.
//
// Order of preference:
//   1. A known platform's own reject control (exact selector, highest trust)
//   2. A button whose text says reject, INSIDE something that is clearly a
//      consent dialog
//   3. Hide the banner and free the page's scroll — no consent recorded
// -------------------------------------
(function () {
  'use strict';

  if (window.__dsConsentRan) return;
  window.__dsConsentRan = true;

  // Exact controls for the platforms that cover most of the web. These are
  // unambiguous: each one is that platform's own "reject" or "necessary only"
  // button, so clicking it needs no text matching and carries no risk of
  // hitting something else.
  const KNOWN_REJECT = [
    '#onetrust-reject-all-handler',                       // OneTrust
    '.ot-pc-refuse-all-handler',                          // OneTrust prefs pane
    '#CybotCookiebotDialogBodyButtonDecline',             // Cookiebot
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    '#didomi-notice-disagree-button',                     // Didomi
    '.didomi-continue-without-agreeing',
    '[data-testid="uc-deny-all-button"]',                 // Usercentrics
    '#uc-btn-deny-banner',
    '.cky-btn-reject',                                    // CookieYes
    '.osano-cm-denyAll',                                  // Osano
    '.cmplz-deny',                                        // Complianz
    '.cn-decline',                                        // Klaro
    '#termly-code-snippet-support .t-declineAllButton',   // Termly
    '.qc-cmp2-summary-buttons > button[mode="secondary"]',// Quantcast
    '.fc-cta-do-not-consent',                             // Google Funding Choices
    '#w-onetrust-reject-all-handler',
    'button[aria-label="Reject all"]',
    'button[aria-label="Deny all"]'
  ];

  // Text used on reject controls, across the locales this extension ships in.
  // Matched only inside a container that already looks like a consent dialog.
  const REJECT_TEXT = [
    'reject all', 'reject', 'decline all', 'decline', 'deny all', 'deny',
    'only necessary', 'necessary only', 'strictly necessary', 'essential only',
    'only essential', 'refuse all', 'refuse', 'continue without accepting',
    'do not consent', 'disagree',
    'alle ablehnen', 'ablehnen', 'nur notwendige',
    'rechazar todo', 'rechazar', 'solo necesarias',
    'tout refuser', 'refuser', 'continuer sans accepter',
    'rifiuta tutto', 'rifiuta',
    'rejeitar tudo', 'rejeitar',
    'отклонить все', 'отклонить',
    'reddet', 'tümünü reddet',
    'رفض الكل', 'رفض',
    'सभी अस्वीकार', 'अस्वीकार',
    'tolak semua', 'tolak',
    'từ chối tất cả', 'từ chối',
    '拒绝全部', '全部拒绝', '拒绝',
    'すべて拒否', '拒否',
    '모두 거부', '거부'
  ];

  // Never press these, whatever else matches.
  const ACCEPT_TEXT = [
    'accept', 'agree', 'allow all', 'got it', 'ok', 'zustimmen', 'akzeptieren',
    'aceptar', 'accepter', 'accetta', 'aceitar', 'принять', 'kabul', 'موافق',
    'स्वीकार', 'terima', 'đồng ý', '同意', '接受', '同意する', '동의'
  ];

  // Something is only treated as a consent dialog if its id, class or role
  // says so. Without this gate, text matching would happily press "Decline"
  // on an unrelated form somewhere on the page.
  const DIALOG_HINT = /(cookie|consent|gdpr|ccpa|privacy|cmp|onetrust|didomi|usercentrics|osano|klaro|termly|complianz|quantcast|trustarc|cookiebot)/i;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function looksLikeConsent(el) {
    for (let n = el, hops = 0; n && n !== document.body && hops < 12; n = n.parentElement, hops++) {
      const id = n.id || '';
      const cls = typeof n.className === 'string' ? n.className : '';
      if (DIALOG_HINT.test(id) || DIALOG_HINT.test(cls)) return n;
      const label = n.getAttribute && (n.getAttribute('aria-label') || n.getAttribute('data-testid'));
      if (label && DIALOG_HINT.test(label)) return n;
    }
    return null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
  }

  function press(el) {
    try {
      el.click();
      return true;
    } catch (e) {
      return false;
    }
  }

  function tryKnown() {
    for (const selector of KNOWN_REJECT) {
      let el;
      try { el = document.querySelector(selector); } catch (e) { continue; }
      if (el && isVisible(el) && press(el)) return 'known';
    }
    return null;
  }

  function tryText() {
    const candidates = document.querySelectorAll(
      'button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]'
    );
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = norm(el.innerText || el.value || el.getAttribute('aria-label'));
      if (!text || text.length > 40) continue;
      // Accept wording wins the check even if a reject word also appears, so
      // "Accept only necessary cookies" is never pressed by this path.
      if (ACCEPT_TEXT.some((w) => text.includes(w))) continue;
      if (!REJECT_TEXT.some((w) => text === w || text.startsWith(w))) continue;
      if (!looksLikeConsent(el)) continue;
      if (press(el)) return 'text';
    }
    return null;
  }

  // Last resort. No consent is recorded — the banner is simply taken off the
  // screen and the page's scroll is given back, which many walls take away.
  function hideBanner() {
    let hidden = false;
    const seen = new Set();
    for (const el of document.querySelectorAll('div, section, aside, dialog')) {
      if (!isVisible(el)) continue;
      const id = el.id || '';
      const cls = typeof el.className === 'string' ? el.className : '';
      if (!DIALOG_HINT.test(id) && !DIALOG_HINT.test(cls)) continue;
      if (seen.has(el)) continue;
      const style = getComputedStyle(el);
      // Only overlays: a fixed or sticky box. An inline cookie notice in the
      // page flow is not in the way and is left alone.
      if (style.position !== 'fixed' && style.position !== 'sticky') continue;
      seen.add(el);
      el.style.setProperty('display', 'none', 'important');
      hidden = true;
    }
    if (hidden) {
      for (const el of [document.documentElement, document.body]) {
        el.style.setProperty('overflow', 'auto', 'important');
        el.style.setProperty('position', 'static', 'important');
      }
    }
    return hidden ? 'hidden' : null;
  }

  function run() {
    return tryKnown() || tryText();
  }

  // Banners are injected late and often after their platform's script has
  // fetched a config, so one pass at document_idle misses most of them. Watch
  // for a short window, then stop — a permanent observer on every page is a
  // cost the user did not ask for.
  let done = false;
  const started = Date.now();
  const WATCH_MS = 8000;

  function attempt() {
    if (done) return;
    if (run()) { done = true; observer.disconnect(); }
  }

  const observer = new MutationObserver(() => {
    if (Date.now() - started > WATCH_MS) { observer.disconnect(); return; }
    attempt();
  });

  attempt();
  if (!done) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      // Nothing pressable was found in the watch window. Take it off screen
      // rather than leaving the user staring at a wall.
      if (!done) hideBanner();
    }, WATCH_MS);
  }
})();
