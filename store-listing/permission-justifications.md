# Permission justifications (Chrome Web Store dashboard)

The dashboard's "Privacy practices" tab asks for justification text for
each sensitive permission. Paste these in as a starting point — adjust
tone/wording if you want, but keep them accurate to what the code
actually does (reviewers do check).

**Current as of 2.6.** 2.6 REMOVES the `webRequest` permission that 2.5
added for the "data used" meter and the data budget — both features were
dropped. If the dashboard still shows a webRequest justification field,
clear it. Removing a permission never disables anyone on update. The
permissions are `declarativeNetRequest`,
`declarativeNetRequestWithHostAccess`, `storage`, `scripting` and
`<all_urls>`.

---

## Single purpose description

Data Saver reduces mobile/limited-bandwidth data usage by blocking ad
and tracker network requests, blocking images, and stopping
autoplaying or streaming video — all three are aspects of one purpose:
minimizing the data a webpage downloads.

## Permission: host_permissions (`<all_urls>`)

Data Saver blocks ads, trackers, images, and video on whatever site
the user is browsing — not a fixed list of sites. Because the set of
sites a user visits is unbounded and can't be predicted in advance,
.the extension needs its network rules and content scripts to be able
to apply on any site. It does not use this permission to read, log,
or transmit page content; it is used exclusively to let Chrome's own
declarativeNetRequest engine evaluate bundled block rules against
outgoing requests, and to run the on-page scripts that pause
autoplay video and clean up blocked-image placeholders.

## Permission: declarativeNetRequest / declarativeNetRequestWithHostAccess

These are the core blocking mechanism. All ad/tracker/image/video
blocking is implemented as static rule files bundled inside the
extension package (rules/*.json) and evaluated by Chrome itself —
the extension's own code never inspects network traffic directly.
declarativeNetRequestWithHostAccess is needed because the bundled
rules must apply across the full breadth of host_permissions above.
A small number of dynamic rules are also used, all of them ALLOW
rules that exempt a site the user chose to unblock or a category they
chose to permit on one site. No dynamic rule ever blocks anything.

## Permission: storage

Stores the user's own settings on their own device: the on/off
preference for each blocking category (ads/images/video), the list of
sites they've chosen not to block on, any per-site exceptions they've
created, and a local tally of how
many requests have been blocked so the extension can show them their
own savings total. While the "Remember which sites" setting is on
(on by default since 2.5 — for new installs, and for existing users
on the update unless they had switched it off), a capped list of the sites where
something was blocked is also stored locally so the dashboard can show
where the savings came from; switching it off deletes the list. Nothing here is transmitted anywhere, and
there is no server to transmit it to.
>
The same permission is what lets the extension read an administrator
policy via chrome.storage.managed, so a school or company can deploy
a fixed configuration. That is read-only and read locally.

## Permission: scripting

Registers the small on-page scripts that (a) pause/stop autoplaying
video and audio elements, (b) hide the broken-image placeholder boxes
left behind when an image is blocked, (c) — only while "Block Videos"
is on — ensure video hidden inside closed shadow DOM can still be
detected and paused, (d) count how many blocked requests occurred on
the page so the extension can show the user a running savings total,
(e) — only if the user switches it on — answer cookie consent banners
with the most privacy-preserving option the banner offers, and (f) —
only if the user switches it on — block pop-up windows that the page
opens without a user gesture.
>
Script (d) observes only load-failure events on the page's own
images, scripts and media elements; it reads no page content, and
reports nothing but counts to the extension's own background script.
Scripts (e) and (f) are on by default since 2.5 (a user who had switched one off keeps it off) and can each be switched off in the dashboard. None of these scripts
collect or transmit data off the device.

---

## Note on the savings counter

The popup shows how many ads, images and videos have been blocked and
an estimate of the data saved. Those counts are produced on the user's
own device, stored on the user's own device, and shown only to that
user. They are never sent anywhere — the extension has no server, no
analytics and no network calls of its own. The byte figure is an
ESTIMATE derived from the number of blocked requests, and the UI
labels it as such, because Chrome exposes no per-request transfer size
to extensions in a production build.

## Note on cookie banner handling (on by default, can be switched off)

While this is on, the extension looks for a consent
banner and presses the option that preserves the most privacy — the
platform's own "reject all" or "necessary only" control, or a button
whose text says the same inside something identifiable as a consent
dialog. **It never presses accept.** Accept wording disqualifies a
button even when reject wording also appears, so a control labelled
"Accept only necessary cookies" is never pressed. If no
privacy-preserving option can be found, the banner is hidden from view
and no consent of any kind is recorded. The extension reads nothing
from the page other than the text of candidate buttons, and transmits
nothing.

## Note on pop-up blocking (on by default, can be switched off)

While this is on, the extension replaces window.open on
the page so that a window opened without a genuine user gesture
returns null — the same result Chrome's own pop-up blocker produces,
which sites already handle. Windows opened as a result of the user
clicking still open normally. Nothing is read from or reported about
the page.

## Note on managed deployment (enterprise/education)

chrome.storage.managed lets an administrator pin any of the blocking
settings by policy. Policy values are read locally, override the
user's own choices, and are shown to the user in the dashboard as
managed rather than hidden. Nothing is reported back to the
administrator by the extension.

---

## Data usage disclosures (the Play-Store-style checklist Chrome's
## dashboard now asks for)

For each category, answer **"No, we don't collect this type of data"** —
that's accurate for all of: personally identifiable info, health info,
financial info, authentication info, personal communications, location,
web history, user activity, website content. Data Saver collects none of
these; see the privacy policy for the full explanation.

**This remains correct in 2.6, including the "web history" and "user
activity" rows, and it is worth being precise about why.** Chrome's
disclosure asks whether data is COLLECTED, which it defines as
transmitted off the user's device. Several features store things
locally, and none of them changes the answer:

- The savings counter keeps per-category counts and a daily total.
- "Remember which sites" keeps a capped list of hostnames where
  something was blocked. It is on by default since 2.5 (a user who had
  switched it off keeps it off).
- "Load image" and "Play on this page" (2.5) keep a one-image rule or a
  tab-and-site note in memory only, removed within a minute or when the
  tab leaves the site.

All of it is held on the user's own machine (`chrome.storage.local`,
session storage and session rules). The extension makes no network
requests of its own, has no server, no analytics and no telemetry, so
nothing can leave the device. The hostname list is additionally capped,
can be switched off, is cleared by the dashboard's Clear history control, and is deleted outright when
the setting is switched off.

If the dashboard asks you to certify compliance with the Developer
Program Policies re: not selling user data — that's also accurate to
check, since nothing is collected in the first place.
