function stopAllVideosDeep(root = document) {
    const videos = root.querySelectorAll('video');
    for (const video of videos) {
        try {
            if (!video.paused) video.pause();
            video.removeAttribute('autoplay');
            video.autoplay = false;
            video.muted = true;
            // Avoid clearing src for visible UI players
            if (!video.closest('body.hidden-videos')) {
                video.src = ''; // stop buffering
            }
        } catch (e) {}
    }
}

// Avoid excessive re-triggering
const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node.nodeType === 1) stopAllVideosDeep(node);
        }
    }
});
observer.observe(document, { childList: true, subtree: true });

// Shadow root observation
function observeShadows() {
    document.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) observer.observe(el.shadowRoot, { childList: true, subtree: true });
    });
}
observeShadows();
stopAllVideosDeep();
