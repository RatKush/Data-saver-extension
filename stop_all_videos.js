// -------------------------------------
// 🚫 STOP ALL VIDEOS (Aggressive Mode)
// -------------------------------------

function stopAllVideos(root = document) {
    const videos = root.querySelectorAll('video');
  
    for (const video of videos) {
      try {
        // Immediately pause any video
        if (!video.paused) video.pause();
  
        // Prevent any further autoplay or buffering
        video.removeAttribute('autoplay');
        video.autoplay = false;
        video.muted = true;
  
        // Remove sources and stop downloading data
        if (video.src) video.removeAttribute('src');
        if (video.currentSrc) video.src = '';
        if (video.load) video.load();
      } catch (e) {
        // Silently ignore any cross-origin video errors
      }
    }
  }
  
  // --- Observe DOM changes for dynamically loaded videos ---
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) stopAllVideos(node);
      }
    }
  });
  
  observer.observe(document, { childList: true, subtree: true });
  
  // --- Observe Shadow DOMs too (for React/Vue/YouTube embeds) ---
  function observeShadows() {
    document.querySelectorAll('*').forEach(el => {
      if (el.shadowRoot) {
        observer.observe(el.shadowRoot, { childList: true, subtree: true });
      }
    });
  }
  
  // --- Initial execution ---
  observeShadows();
  stopAllVideos();
  