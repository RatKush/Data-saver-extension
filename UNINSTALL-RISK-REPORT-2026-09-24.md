# Data Saver: real-Chrome audit and uninstall-risk report

**Date:** 2026-09-24 · **Build tested:** `dist/data-saver-extension-v2.3.zip` (plus `v2.1` for the upgrade path) · **Browser:** Google Chrome 154.0.8037.58 (real Chrome), fresh profiles, extension loaded unpacked through DevTools

## Bottom line

Data Saver's core promise is real: on 66 sites it cut **51% of all downloaded bytes**. But a new user very quickly runs into things that make it look like it **breaks the web or freezes Chrome**. Five of them are serious:

1. **Pressing play on a video can freeze the tab at 100% CPU**, and some news sites freeze on page load (confirmed on Times of India and a plain HTML5 video page). The cause is an endless loop in `stop_all_media.js`. **Fixed and verified in a test copy.**
2. **Image "request storms":** on sites like Flipkart and Stack Overflow, blocking images makes Chrome re-request them **80,000–150,000 times in 20 seconds**, using up to 93% CPU. The counter then claims **"≈ 15.7 GB saved"** after one visit. **Fixed and verified in a test copy.**
3. **Every outbound link on X/Twitter is blocked** (`t.co`), and so are the "Buy" links on review and deals sites, which go through affiliate redirectors.
4. **CAPTCHAs become unsolvable.** The reCAPTCHA challenge shows an empty grid ("Select all images with a bus" over blank tiles), so sign-ups, logins and checkouts fail.
5. **Image-tile maps go blank.** OpenStreetMap loaded 0 of 24 tiles.

The store export (below) also shows that, until 2.2/2.3, **YouTube and every other video site were broken by default** for nearly all users.

---

## What the store data says

From `Weekly users over time_….xlsx` (daily data, 2025-10-28 → 2026-09-11):

| Month | Installs | Uninstalls | Uninstalls ÷ installs | Weekly users (end) |
|---|---|---|---|---|
| Nov 2025 – May 2026 | 273–892 / month | 68–256 | **25–31%** | 164 → 1,727 |
| Jun 2026 | 746 | 270 | 36% | 1,978 |
| Jul 2026 | 767 | 262 | 34% | 2,200 |
| Aug 2026 | 678 | 298 | **44%** | 2,331 |
| Sep 1–11 | 189 | 84 | **44%** | 2,352 |

- **Lifetime:** 6,469 installs, 2,078 recorded uninstalls, about 2,350 weekly users. Growth has stalled around 2,300.
- Uninstalls have held steady at about **8–15 a day** since May, while installs fell from about 30 a day to about 20. So the rising ratio is **partly weaker acquisition**, not only new breakage.
- 93% of users are on Windows.
- Versions: `0.1.0.0` until 28 Aug, then `2.1` (about 1,290 users). **2.2 and 2.3 shipped after this export ended**, so none of their fixes are reflected in these numbers yet.
- **On v2.1, YouTube does not play at all** (verified: video paused, `readyState 0`). Until 2.2/2.3 seeded the 30-site video allowlist, every user had YouTube, Netflix, Instagram and the rest broken by default. That's very likely a large share of the historical uninstalls. **The 2.1 → 2.3 update path works:** settings are kept, the 30 video sites are seeded, and the welcome tab is not reopened.

---

## How it was tested

| What | Scope |
|---|---|
| Site sweep | 66 sites (news in the US, UK, India, Indonesia, Nigeria, Pakistan, Bangladesh, Brazil; shopping; social; search; login; tools; maps; CAPTCHAs; payments; banks; government; education; video) × 3 real Chrome instances: **no extension**, **Data Saver defaults** (ads + images + video), **ads-only** |
| Per page | real bytes downloaded, blocked requests by type, images and videos, new JS errors vs. clean, text vs. clean, main-thread / script time, screenshot |
| Functional | install and welcome page, popup (real clicks), counter vs. Chrome's own count, per-site pause, image switch, dashboard premium switches, t.co and affiliate / ad-click / email links, reCAPTCHA and hCaptcha challenges, OpenStreetMap and Google Maps, IRCTC login captcha, WhatsApp Web QR, pressing play on a site video, upgrade from 2.1 |
| Root cause | freeze confirmed with main-thread measurement and a debugger break-in (`stop_all_media.js:55`); storm isolated by switching off one component at a time |
| Fix proofs | both fixes applied to a scratch copy and re-measured on the same sites |

---

## Findings, ranked by likely uninstall impact

### 1. Critical: tabs freeze at 100% CPU (video handling loop)

- **Repro:** open `https://www.w3schools.com/html/html5_video.asp` and press play. The main thread goes from 2% busy to **100%**, and the page stops responding (no reply to 3 × 20 s probes). Without Data Saver the video plays normally.
- **Also on plain page loads with no clicks:** **Times of India** froze completely on load, and Daily Mail froze during the sweep. They load fine without the extension and with ads-only.
- **Cause:** `stop_all_media.js` lines 25–27, driven by its own MutationObserver (line 65, `attributeFilter: ['src', …]`):
  1. `el.src = ''` *adds* a `src` attribute, and the observer fires.
  2. An empty `src` resolves to the page URL, so `if (el.src)` is true and the attribute is removed. The observer fires again.
  3. `currentSrc` is still set, so `el.src = ''` runs again, forever, with `el.load()` on every pass.

  The debugger confirmed the page was stuck at `stop_all_media.js:55`.
- **Fix (verified: 100% → 1% CPU, Times of India responsive):**

  ```js
  // stop_all_media.js, in stopMedia(): replace the three "Remove sources" lines
  let changed = false;
  if (el.hasAttribute('src')) { el.removeAttribute('src'); changed = true; }
  for (const s of el.querySelectorAll('source')) { s.remove(); changed = true; }
  if (changed && el.load) el.load();
  ```

### 2. Critical: image request storms burn CPU and inflate the counter to absurd numbers

- **Evidence:** from a single 20-second visit:

  | Site | Blocked image requests | Page CPU | Popup then claims |
  |---|---|---|---|
  | Flipkart | 93,815 | **18.6 s of 20 s** | **470,303 requests blocked, ≈ 15.70 GB saved** |
  | Stack Overflow | 156,167 | 9.9 s of 20 s | ≈ 5.20 GB saved |
  | Detik | 13,879 in the sweep | — | — |

- **Cause:** the `images.json` **block** rule itself. With every page script disabled it still happened (107,210 requests in 15 s); with the images rule off it stopped (1 request). Chrome keeps re-requesting images that fail with `ERR_BLOCKED_BY_CLIENT`, most likely CSS background images re-fetched on every re-layout.
- **Why it drives uninstalls:** the laptop fan spins up, the page lags, and a "15.7 GB saved" figure is obviously false, so users stop trusting everything else the popup says. The review card would read "You've blocked 470,303 requests…".
- **Fix (verified):** redirect instead of block. Serve a packaged 1×1 transparent GIF:

  ```json
  // rules/images.json
  [{ "id": 2, "priority": 1,
     "action": { "type": "redirect", "redirect": { "extensionPath": "/blank.gif" } },
     "condition": { "resourceTypes": ["image"] } }]
  ```

  Also add `blank.gif` under `web_accessible_resources` with `<all_urls>`. Results:
  - Stack Overflow: 111,975 → **1** failed request, CPU 6.9 s → **0.3 s**
  - Flipkart: 79,042 → **11**, CPU 13.8 s → **1.2 s**
  - BBC: unchanged
  - **Same bytes saved on all three**, and no broken-image icons

  One knock-on: `savings_counter.js` counts image *error* events, which redirected images no longer fire. Counting has to move to, for example, a `load` listener that checks for the 1×1 size, or resource-timing entries. `hide_broken_images.js` becomes unnecessary.

### 3. High: links on X and on review/deals sites are dead

- **Evidence:** navigations to these domains return `ERR_BLOCKED_BY_CLIENT` with Data Saver, and load normally without it:
  - **`t.co`**, which every outbound link on X/Twitter goes through
  - Skimlinks (`go.redirectingat.com`, `go.skimresources.com`)
  - CJ (`anrdoezrs.net`)
  - Rakuten (`click.linksynergy.com`)
  - Awin (`awin1.com`)

  Google Ads click-throughs, `ad.doubleclick.net` email click-tracking and `hubspotlinks.com` are also blocked. My test links for those three were invalid, so there was no clean comparison.
- **Cause:** every one of the 3,559 rules in `rules/ad-domains.json` (from pgl.yoyo.org) includes `main_frame`, so a *click* the user deliberately makes is blocked, not just ads loading inside a page. The list also contains ShareASale, VigLink, Partnerize (`prf.hn`), Tradedoubler, `hubspotlinks.com`, Outbrain and Taboola.
- **Fix:** drop `main_frame` from `ad-domains.json` (keep `sub_frame`, `script`, `image` and the rest), or at minimum exclude link redirectors (`t.co` and the affiliate networks).

### 4. High: CAPTCHAs cannot be solved

- **Evidence:** on the reCAPTCHA demo the challenge opened as **"Select all images with a bus" over an empty white grid**, with 6 reCAPTCHA image requests blocked. hCaptcha also had 3 image requests blocked.
- **Why it matters:** CAPTCHAs sit on sign-ups, logins, password resets, checkouts and contact forms. A user who can't get past one blames the extension. It's the same "breaks websites" experience as finding 3.
- **Fix:** add allow rules above the images rule for challenge assets:
  - `||www.google.com/recaptcha/`, `||www.gstatic.com/recaptcha/`, `||recaptcha.net^`
  - `||hcaptcha.com^`, `||imgs.hcaptcha.com^`
  - `||challenges.cloudflare.com^`

### 5. High: tile maps go blank

- **Evidence:** OpenStreetMap loaded **0 of 24** tiles, so the map area is empty. Many store locators, delivery trackers, property and travel sites use tile maps (OpenStreetMap / Leaflet, Mapbox, ArcGIS, HERE).
- **Google Maps is fine** because it draws vector graphics, not image tiles.
- **Fix:** allow the common tile hosts (`tile.openstreetmap.org`, `*.tile.*`, `api.mapbox.com/styles`, `server.arcgisonline.com`, …), or allow images inside map containers.

### 6. Medium: the savings claims don't match what users get

- **Measured across 66 sites:**
  - **51% of total bytes saved, but the median site saves 35%.** The biggest wins are video-heavy pages: Kompas 91%, BBC Reel 92%, NDTV 80%, CNN 70%.
  - Many everyday sites save under 10%: X, Facebook, LinkedIn, Google Search, Walmart, ChatGPT, Microsoft login, Chase.
- **Ads-only saves 16% of bytes, and 1% on the median site.** Nearly all the saving comes from blocking images and video, the part that makes pages look broken.
- The README says *"at least 50% bandwidth… for a typical news site saving can be almost 90%"*. Only video-heavy news sites reach that.
- **The popup estimate runs about 2× high on normal pages:** ≈ 10.1 MB claimed against about 5.4 MB actually saved on the same 6 pages (`AVG_BYTES.images` = 35 KB is generous for thumbnails). On storm pages it is off by orders of magnitude (finding 2).
- **Fix:** keep the exact request count as the headline, which is accurate: 193 counted vs. 212 Chrome-blocked. Lower `AVG_BYTES.images`, or measure. Tone down "at least 50%".

### 7. Medium: pressing play silently does nothing

- Even after fix 1, a user who clicks play on a site video sees nothing happen and gets no explanation (`play()` → `AbortError`). The popup is the only place blocking is visible.
- **Fix:** a small inline overlay on stopped videos ("Video paused by Data Saver · Play once · Allow on this site") would turn a "broken" moment into a feature.

### 8. Medium: favicons disappear on every site

- Favicons are fetched as images, so they're blocked everywhere. Browser tabs and bookmarks lose their icons, which is a constant visual signal that "something is broken". An allow rule for favicon paths (a regex on `/favicon`, `apple-touch-icon`, `/icon`) costs almost nothing in bytes.

### 9. Medium: race at install registers every page script twice

- On first install the service worker logged `registerContentScripts … error: Duplicate script ID` for all four scripts. `onInstalled → loadAndSetInitialState()` and the `storage.onChanged` fired by `seedDefaultAllowlist()` reconcile at the same moment.
- This run ended in the right state (60 exclude patterns, i.e. all 30 video sites). But the outcome depends on timing, so a user could end up with scripts carrying a stale exclude list. For example, video blocking could still be active on YouTube while the popup says it's allowed.
- **Fix:** serialise reconciles through a single promise chain, as the ad blocker already does for its totals.

### 10. Low / watch

- **`force_open_shadow_dom.js`** patches `attachShadow` in the MAIN world on every site whenever video blocking is on, which is the default. Its own comment flags the risk to payment forms and CAPTCHAs. No breakage in the sweep was clearly attributable to it. Consider enabling it only on sites where closed shadow roots actually hide media.
- **Microsoft login** showed 15 new JS errors with defaults (0 with ads-only). The page still rendered; this needs a login-flow test with a real account.
- **No uninstall feedback URL.** `setUninstallURL` isn't used, so the reasons behind 2,078 uninstalls are unknown.

---

## What works well

- **The core idea delivers:** 239 MB → 116 MB across the sweep. Video-heavy and image-heavy news, recipe and education sites save 45–92%.
- **The video allowlist works in 2.3:** YouTube and Twitch load with 0 blocked requests and identical bytes. It fixes the biggest pre-2.2 problem.
- **Unaffected by image blocking:** IRCTC login captcha (a data-URL image), WhatsApp Web QR login (canvas) and Google Maps (vector).
- **The popup is solid:**
  - accurate request count
  - "Don't block on this site" instantly restores images, with badge **OFF**
  - the image switch correctly disables its ruleset
  - clear welcome tab on first install
- **Dashboard:** loads cleanly, and the premium switches (cookie banners, pop-up blocker, auto mode) register their scripts and persist.
- **Upgrade 2.1 → 2.3:** settings kept, video sites seeded, no welcome tab on update.

---

## Suggested fix order

| # | Fix | Effort | Addresses |
|---|---|---|---|
| 1 | Loop fix in `stop_all_media.js` (patch above, verified) | Tiny | #1 |
| 2 | Redirect images to a 1×1 GIF instead of blocking (verified); move the image counter to `load` | Small | #2, #8 (partly) |
| 3 | Remove `main_frame` from `ad-domains.json` (or exclude t.co and affiliate redirectors) | Tiny | #3 |
| 4 | Allow CAPTCHA, tile-map and favicon image hosts | Small | #4, #5, #8 |
| 5 | Serialise `refreshAll` reconciles | Small | #9 |
| 6 | Inline "video paused" overlay; honest savings copy and `AVG_BYTES`; `setUninstallURL` survey | Small–Medium | #6, #7, #10 |

Fixes 1–3 are one-to-ten-line changes and remove the "freezes Chrome", "breaks X" and "15 GB saved" experiences.

## Caveats

- Headless real Chrome from an Indian IP. Some sites vary by region and by bot detection. Shopee Indonesia served no content to headless Chrome even without the extension, so it's excluded from conclusions.
- The freeze is timing-dependent on news sites: Daily Mail froze in the sweep but not on a later reload. On a plain `<video>` page it reproduced every time.
- No logged-in flows (Gmail, banking) were exercised.
- The store export ends on 2026-09-11, before 2.2 and 2.3 reached users.
- Both fixes were applied only to a scratch copy (`ext-fix/`), not to this project. Ask if you want them applied here, along with the real-Chrome test scripts.

---

## Fixes applied (v2.4, branch `fix/uninstall-audit`, not committed)

Verified in real Chrome 154 against the built `dist/data-saver-extension-v2.4.zip`.

| Finding | Change | Verified |
|---|---|---|
| #1 tab freeze | `stop_all_media.js` removes `src` and `<source>` once and never writes `src = ''`. | Play on a `<video>`: responds in 5 ms, 4% CPU. Times of India loads normally. |
| #7 silent video stop | In-page notice "Data Saver stopped this video to save data · Play videos on this site", shown on a click on a stopped video. The button saves a merged site profile `{ media: false }` and reloads. | Notice shown. After the click the video plays. |
| #2 image storms, absurd counter | `images.json` redirects to a packaged 1×1 `blank.gif` instead of blocking. The counter counts those loads once per element, only where images are blocked, max 1,500 per page. Failed `<img>` is no longer counted. `AVG_BYTES.images` is now 18 KB. | Stack Overflow: 1 failed request, CPU 0.2 s, counter +17. Flipkart: 10 failed, 1.0 s, +106. BBC/CNN bytes unchanged. |
| #3 dead links | `main_frame` removed from all 3,559 `ad-domains.json` rules and from `scripts/update-ad-domains.py`. | t.co, Skimlinks, CJ and Awin all navigate. |
| #4 CAPTCHAs, #5 maps, #8 favicons | Allow rules in `images.json` for reCAPTCHA, hCaptcha, Cloudflare and Arkose challenges; common tile servers; favicon paths. | 0 reCAPTCHA images blanked. OpenStreetMap 24/24 tiles. Favicons match the allow rule. |
| #9 install race | Reconciles run strictly one at a time (`reconcileChain`). Each step returns a promise. | No "Duplicate script ID". All scripts carry 60 excludes. |
| #10 no uninstall feedback | `setUninstallURL` → `/uninstall` (new `docs/uninstall.html`: fixes plus a link to the store support page; deploy the site). | — |
| #6 savings claim | README now states the measured figures. | — |

Version bumped to 2.4. `test-savings.mjs` 102/102 (updated for the new counter, plus 6 new tests). The locale check passes. YouTube is still untouched.

### Not applied — needs your decision

- **`force_open_shadow_dom.js` runs on every site.** Consider scoping it to sites where closed shadow roots actually hide media.
- **Microsoft login JS errors:** needs a real-account login test.
