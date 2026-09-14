// Entrance animation for welcome.html.
//
// Lives in its own file because MV3's default CSP (script-src 'self') blocks
// inline <script> on extension pages — an inline version would silently never
// run and the page would just sit there.
//
// Everything here is enhancement only. The stylesheet's resting state is the
// FINISHED state, and this script opts in to animating by adding .anim to
// <body>. If the script fails, is blocked, or the user prefers reduced motion,
// the page still renders complete and readable.

(function () {
  'use strict';

  var reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (reduced) return;

  document.body.classList.add('anim');

  // Collapse the bar only once we know we are going to animate it — if this
  // script never runs, CSS leaves the segments at their final widths.
  var segs = document.querySelectorAll('.weight .seg');
  for (var s = 0; s < segs.length; s++) segs[s].style.width = '0%';

  var items = document.querySelectorAll('.rise');

  // Stagger the reveal. Capped so the tail of a long page never feels like
  // it is waiting on the top of it.
  function reveal() {
    for (var i = 0; i < items.length; i++) {
      (function (el, delay) {
        setTimeout(function () { el.classList.add('in'); }, delay);
      })(items[i], Math.min(i * 70, 700));
    }
  }

  // The stacked bar grows from nothing to the real shares, so the split is
  // something you watch assemble rather than a static picture. Widths live in
  // data-w on each segment so the markup stays the single source of truth.
  function growWeightBar() {
    var segs = document.querySelectorAll('.weight .seg');
    for (var i = 0; i < segs.length; i++) {
      (function (seg, index) {
        setTimeout(function () {
          seg.style.width = seg.getAttribute('data-w') + '%';
        }, index * 110);
      })(segs[i], i);
    }
  }

  function start() {
    reveal();
    // Let the first paint land before moving anything, otherwise the bar
    // transition is skipped and the collapse is never seen.
    setTimeout(growWeightBar, 420);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
