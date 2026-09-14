# Permission justifications (Chrome Web Store dashboard)

The dashboard's "Privacy practices" tab asks for justification text for
each sensitive permission. Paste these in as a starting point — adjust
tone/wording if you want, but keep them accurate to what the code
actually does (reviewers do check).

**Current as of 2.3.** No new permissions were added since 2.1: everything
below is still `declarativeNetRequest`, `declarativeNetRequestWithHostAccess`,
`storage`, `scripting` and `<all_urls>`. The managed-policy support added in
2.3 uses a manifest key (`storage.managed_schema`) under the existing
`storage` permission and produces no additional install-time warning.

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
> A small number of dynamic rules are also used, all of them ALLOW
> rules that exempt a site the user chose to unblock or a category they
> chose to permit on one site. No dynamic rule ever blocks anything.

## Permission: storage

> Stores the user's own settings on their own device: the on/off
> preference for each blocking category (ads/images/video), the list of
> sites they've chosen not to block on, any per-site exceptions they've
> created, the optional data-budget settings, and a local tally of how
> many requests have been blocked so the extension can show them their
> own savings total. If the user switches on the optional "Remember
> which sites" setting, a capped list of the sites where something was
> blocked is also stored locally so the dashboard can show where the
> savings came from; that setting is OFF by default and switching it
> off again deletes the list. Nothing here is transmitted anywhere, and
> there is no server to transmit it to.
>
> The same permission is what lets the extension read an administrator
> policy via chrome.storage.managed, so a school or company can deploy
> a fixed configuration. That is read-only and read locally.

## Permission: scripting

> Registers the small on-page scripts that (a) pause/stop autoplaying
> video and audio elements, (b) hide the broken-image placeholder boxes
> left behind when an image is blocked, (c) — only while "Block Videos"
> is on — ensure video hidden inside closed shadow DOM can still be
> detected and paused, (d) count how many blocked requests occurred on
> the page so the extension can show the user a running savings total,
> (e) — only if the user switches it on — answer cookie consent banners
> with the most privacy-preserving option the banner offers, and (f) —
> only if the user switches it on — block pop-up windows that the page
> opens without a user gesture.
>
> Script (d) observes only load-failure events on the page's own
> images, scripts and media elements; it reads no page content, and
> reports nothing but counts to the extension's own background script.
> Scripts (e) and (f) are both OFF by default. None of these scripts
> collect or transmit data off the device.

---

## Note on the savings counter

> The popup shows how many ads, images and videos have been blocked and
> an estimate of the data saved. Those counts are produced on the user's
> own device, stored on the user's own device, and shown only to that
> user. They are never sent anywhere — the extension has no server, no
> analytics and no network calls of its own. The byte figure is an
> ESTIMATE derived from the number of blocked requests, and the UI
> labels it as such, because Chrome exposes no per-request transfer size
> to extensions in a production build.

## Note on cookie banner handling (optional, off by default)

> When the user switches this on, the extension looks for a consent
> banner and presses the option that preserves the most privacy — the
> platform's own "reject all" or "necessary only" control, or a button
> whose text says the same inside something identifiable as a consent
> dialog. **It never presses accept.** Accept wording disqualifies a
> button even when reject wording also appears, so a control labelled
> "Accept only necessary cookies" is never pressed. If no
> privacy-preserving option can be found, the banner is hidden from view
> and no consent of any kind is recorded. The extension reads nothing
> from the page other than the text of candidate buttons, and transmits
> nothing.

## Note on pop-up blocking (optional, off by default)

> When the user switches this on, the extension replaces window.open on
> the page so that a window opened without a genuine user gesture
> returns null — the same result Chrome's own pop-up blocker produces,
> which sites already handle. Windows opened as a result of the user
> clicking still open normally. Nothing is read from or reported about
> the page.

## Note on the data budget (optional, off by default)

> The user can enter a monthly allowance and a billing reset day, and
> the extension blocks progressively harder as the cycle runs down.
> **It does not measure the user's data consumption and never displays a
> figure for it** — Chrome exposes no such API, and the user's real cap
> covers their whole device rather than one browser. The feature works
> only from the two numbers the user typed in and the current date.

## Note on managed deployment (enterprise/education)

> chrome.storage.managed lets an administrator pin any of the blocking
> settings by policy. Policy values are read locally, override the
> user's own choices, and are shown to the user in the dashboard as
> managed rather than hidden. Nothing is reported back to the
> administrator by the extension.

---

## Data usage disclosures (the Play-Store-style checklist Chrome's
## dashboard now asks for)

For each category, answer **"No, we don't collect this type of data"** —
that's accurate for all of: personally identifiable info, health info,
financial info, authentication info, personal communications, location,
web history, user activity, website content. Data Saver collects none of
these; see the privacy policy for the full explanation.

**This remains correct in 2.3, including the "web history" and "user
activity" rows, and it is worth being precise about why.** Chrome's
disclosure asks whether data is COLLECTED, which it defines as
transmitted off the user's device. Two 2.3 features store more than
before, and neither changes the answer:

- The savings counter keeps per-category counts and a daily total.
- The optional "Remember which sites" setting keeps a capped list of
  hostnames where something was blocked.

Both are written to `chrome.storage.local` on the user's own machine.
The extension makes no network requests of its own, has no server, no
analytics and no telemetry, so nothing can leave the device. The
hostname list is additionally **off by default**, capped, clearable by
its own control, and deleted outright when the setting is switched off.

If the dashboard asks you to certify compliance with the Developer
Program Policies re: not selling user data — that's also accurate to
check, since nothing is collected in the first place.
