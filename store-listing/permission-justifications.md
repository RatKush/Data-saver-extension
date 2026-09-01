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
> (ads/images/video) and the list of sites they've chosen to pause
> blocking on. Used only to persist the user's own settings between
> sessions; nothing here is transmitted anywhere.

## Permission: scripting

> Registers the small on-page scripts that (a) pause/stop autoplaying
> video and audio elements, (b) hide the broken-image placeholder boxes
> left behind when an image is blocked, and (c) — only while "Block
> Videos" is on — ensure video hidden inside closed shadow DOM can still
> be detected and paused. None of these scripts collect or transmit
> data; they only modify the DOM of the current page.

---

## Data usage disclosures (the Play-Store-style checklist Chrome's
## dashboard now asks for)

For each category, answer **"No, we don't collect this type of data"** —
that's accurate for all of: personally identifiable info, health info,
financial info, authentication info, personal communications, location,
web history, user activity, website content. Data Saver collects none of
these; see the privacy policy for the full explanation.

If the dashboard asks you to certify compliance with the Developer
Program Policies re: not selling user data — that's also accurate to
check, since nothing is collected in the first place.
