# Permission justifications (Chrome Web Store dashboard)

The dashboard's "Privacy practices" tab asks for justification text for
each sensitive permission. Paste these in as a starting point — adjust
tone/wording if you want, but keep them accurate to what the code
actually does (reviewers do check).

---

## Single purpose description

> Data Saver reduces mobile/limited-bandwidth data usage by blocking ad
> and tracker network requests, blocking images, and stopping
> autoplaying or streaming video — all three are aspects of one purpose:
> minimizing the data a webpage downloads.

## Permission: host_permissions (`<all_urls>`)

> Data Saver blocks ads, trackers, images, and video on whatever site
> the user is browsing — not a fixed list of sites. Because the set of
> sites a user visits is unbounded and can't be predicted in advance,
> the extension needs its network rules and content scripts to be able
> to apply on any site. It does not use this permission to read, log,
> or transmit page content; it is used exclusively to let Chrome's own
> declarativeNetRequest engine evaluate bundled block rules against
> outgoing requests, and to run the on-page scripts that pause
> autoplay video and clean up blocked-image placeholders.

## Permission: declarativeNetRequest / declarativeNetRequestWithHostAccess

> These are the core blocking mechanism. All ad/tracker/image/video
> blocking is implemented as static rule files bundled inside the
> extension package (rules/*.json) and evaluated by Chrome itself —
> the extension's own code never inspects network traffic directly.
> declarativeNetRequestWithHostAccess is needed because the bundled
> rules must apply across the full breadth of host_permissions above.

## Permission: storage

> Stores the user's own on/off preference for each blocking category
> (ads/images/video), the list of sites they've chosen not to block on,
> and a local tally of how many requests have been blocked so the
> extension can show the user their own savings total. Used only to
> persist the user's own settings and counts between sessions on their
> own device; nothing here is transmitted anywhere, and there is no
> server to transmit it to.

## Permission: scripting

> Registers the small on-page scripts that (a) pause/stop autoplaying
> video and audio elements, (b) hide the broken-image placeholder boxes
> left behind when an image is blocked, (c) — only while "Block Videos"
> is on — ensure video hidden inside closed shadow DOM can still be
> detected and paused, and (d) count how many blocked requests occurred
> on the page so the extension can show the user a running savings
> total. Script (d) observes only load-failure events on the page's own
> images, scripts and media elements; it reads no page content, and
> reports nothing but three integers to the extension's own background
> script. None of these scripts collect or transmit data off the device.

## Note on the savings counter (new in v2.2)

> The popup shows how many ads, images and videos have been blocked and
> an estimate of the data saved. Those counts are produced on the user's
> own device, stored on the user's own device, and shown only to that
> user. They are never sent anywhere — the extension has no server, no
> analytics and no network calls of its own. The byte figure is an
> ESTIMATE derived from the number of blocked requests, and the UI
> labels it as such, because Chrome exposes no per-request transfer size
> to extensions in a production build.

---

## Data usage disclosures (the Play-Store-style checklist Chrome's
## dashboard now asks for)

For each category, answer **"No, we don't collect this type of data"** —
that's accurate for all of: personally identifiable info, health info,
financial info, authentication info, personal communications, location,
web history, user activity, website content. Data Saver collects none of
these; see the privacy policy for the full explanation.

This stays accurate with the v2.2 savings counter. Chrome's disclosure
asks whether data is COLLECTED, which it defines as transmitted off the
user's device. The counter's three integers never leave the machine and
the extension makes no network requests of its own, so "No" remains the
correct answer for every row — including "user activity".

If the dashboard asks you to certify compliance with the Developer
Program Policies re: not selling user data — that's also accurate to
check, since nothing is collected in the first place.
