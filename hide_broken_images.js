// -------------------------------------
// 🖼️ HIDE BROKEN IMAGES
// rules/images.json blocks every image request at the network layer, but
// the browser still renders a broken-image icon/alt-text box and reserves
// its layout space. This purely-visual cleanup layer collapses those boxes
// so blocked pages read cleanly instead of looking broken.
// -------------------------------------

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
  if (target instanceof HTMLImageElement) collapseImage(target);
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
