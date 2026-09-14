# Data-saver-extension
get it from chrome web store https://chromewebstore.google.com/detail/Data%20Saver/cjijlgnefahbmcogbhacnnnlnaeolmjg

2,300+ weekly users and 4,300+ installs to date.

<img width="1105" height="76" alt="image" src="https://github.com/user-attachments/assets/6a959ee1-1985-4289-b580-0b93f542ec9c" />


A tool that saves internet bandwidth by blocking costly images / ads / media. The popup shows exactly how many requests it has blocked and an estimate of the data that saved. Specially useful for rural areas where bandwidth is low or limited.
For best experiance block all 3 options available images/ ads and media. It will save at least 50% bandwidth, for a typical new site saving can be almost 90% approx.

## What's in it

- **Three independent toggles** — ads and trackers, images, video and audio.
- **One tap to unblock the current site**, from the top of the popup or with `Alt+Shift+D`. The toolbar badge reads `OFF` where blocking is paused.
- **Video platforms ship unblocked** — YouTube, Netflix, Instagram, Twitch and 26 others. You already know those cost data; blocking them just breaks them.
- **Per-site rules** — block ads on a site but let its images through, or the reverse. Subdomain-aware.
- **Savings meter** — the exact number of blocked requests, with an estimate of the data that saved beside it.
- **Dashboard** — a 14-day trend, your per-site rules, and everything below. Open it from the popup.
- **Cookie banners** (off by default) — answers them with "reject" or "necessary only". It never accepts on your behalf.
- **Pop-up blocking** (off by default) — stops windows a page opens on its own; ones you click still work.
- **Adapt to connection speed** (off by default) — stops blocking images on a fast connection.
- **Data budget** (off by default) — set an allowance and a billing date and it blocks harder as the cycle runs down.
- **Managed policy** — settings can be pinned by an administrator, and any configuration exports as a file.
- Ships in **25 languages**.

Two things it deliberately does not do: the savings figure in bytes is an **estimate** derived from blocked-request counts, because Chrome exposes no per-request transfer size to extensions; and the data budget **does not measure your usage** and never shows data remaining — no extension can see that, so it paces from your allowance and the date instead.

**Privacy:** there is no server, no analytics and no telemetry. Everything is stored on your own device. The optional site-history list is off by default and is deleted when you switch it off.

| **Category** | **Typical Percentage of Total Page Weight** | **Notes** |
|--------------|---------------------------------------------|------------|
| Images (e.g., product photos, background graphics, logos) | 30% - 60% | Images are consistently the single largest component for most sites, particularly e-commerce and media-heavy blogs. |
| Media (Videos/Audio) | 10% - 35% | This varies wildly. A site with an embedded, auto-playing video will have a much higher percentage. For simple blogs, it might be near 0%. |
| Ads/Third-Party (Scripts, Banners, Pixels) | 10% - 30% | Includes the weight of ad banners, tracking scripts, and other third-party services, which can significantly impact performance. |
