# Data-saver-extension
get it from chrome web store https://chromewebstore.google.com/detail/Data%20Saver/cjijlgnefahbmcogbhacnnnlnaeolmjg

2,300+ weekly users and 4,300+ installs to date.

<img width="1105" height="76" alt="image" src="https://github.com/user-attachments/assets/6a959ee1-1985-4289-b580-0b93f542ec9c" />


A tool that saves internet bandwidth by blocking costly images / ads / media. The popup shows exactly how many requests it has blocked and an estimate of the data that saved. Specially useful for rural areas where bandwidth is low or limited.
For the biggest savings keep all three blocks on (ads, images and video). Measured in Chrome across 66 popular sites, that cut about half of all downloaded data; the typical page saved around a third, and video-heavy news pages 70–90%.

## What's in it

- **Three independent toggles** — ads and trackers, images, video and audio.
- **One tap to unblock the current site**, from the top of the popup or with `Alt+Shift+D`. The toolbar badge reads `OFF` where blocking is paused.
- **Video, call and remote-desktop sites ship unblocked** — YouTube, Netflix, Instagram, Twitch and other video platforms; Google Meet, Zoom, Teams, Webex, JioMeet and other meeting apps; Chrome Remote Desktop, AnyDesk, TeamViewer and Splashtop; and WhatsApp Web, Discord and Slack, so voice notes and calls play. Blocking them just breaks them.
- **Per-site rules** — block ads on a site but let its images through, or the reverse. Subdomain-aware.
- **Savings meter** — the exact number of blocked requests, with an estimate of the data that saved beside it.
- **Dashboard** — a 14-day trend, your per-site rules, and everything below. Open it from the popup.
- **Cookie banners** (on by default) — answers them with "reject" or "necessary only". It never accepts on your behalf.
- **Pop-up blocking** (on by default) — stops windows a page opens on its own; ones you click still work.
- **Adapt to connection speed** (off by default) — stops blocking images on a fast connection.
- **Load one image, play one video** — a blocked image shows a faint placeholder with a *Load image* button, and a stopped video offers *Play on this page*. Nothing else on the site is unblocked.
- **Managed policy** — settings can be pinned by an administrator, and any configuration exports as a file.
- Ships in **25 languages**.

One thing to know: the savings figure in bytes is an **estimate** derived from blocked-request counts, because Chrome exposes no size for a request that never happened.

**Privacy:** there is no server, no analytics and no telemetry. Everything is stored on your own device. The site-history list (on by default since 2.5) stays on your device and is deleted when you switch it off.

| **Category** | **Typical Percentage of Total Page Weight** | **Notes** |
|--------------|---------------------------------------------|------------|
| Images (e.g., product photos, background graphics, logos) | 30% - 60% | Images are consistently the single largest component for most sites, particularly e-commerce and media-heavy blogs. |
| Media (Videos/Audio) | 10% - 35% | This varies wildly. A site with an embedded, auto-playing video will have a much higher percentage. For simple blogs, it might be near 0%. |
| Ads/Third-Party (Scripts, Banners, Pixels) | 10% - 30% | Includes the weight of ad banners, tracking scripts, and other third-party services, which can significantly impact performance. |
