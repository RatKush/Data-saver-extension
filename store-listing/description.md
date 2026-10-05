# Store listing description — notes

**The text to paste lives in `description.txt`, not here.**

That split exists because of a real bug: this file used to be the paste
source and was written in Markdown, so `**What it blocks**` went into the
listing with the asterisks visible. **The Chrome Web Store description field
is plain text. It does not render Markdown** — no `**bold**`, no `#`
headings, no `[links](…)`. Emoji and line breaks are all the formatting
there is.

`description.txt` contains exactly what goes in the field and nothing else,
so there is no header to accidentally paste and no markup to strip.

## What it is written for

Search ranking, primarily. The funnel says the copy is not what loses
people — pageview→install ran at 60.5% in August, the best it has been —
while impressions fell from 4,546 in May to 3,522 in August. Discovery is
the constraint, and the description feeds per-locale Web Store search.

Search ranking must never be pursued by repetition or lists, though. After
the 2.5 rejection (below), the text was cut from ~6,300 to ~3,800 characters
and the keyword-first FAQ went: it repeated every feature a second time and
pushed "data" to 19 uses. The description now covers the key phrases
(save mobile data, block images, autoplay video, Lite Mode, capped or metered)
**once each**. The appName and appDesc carry most of the search weight anyway.

## Two claims that must never be overstated

- **The savings meter is an ESTIMATE** derived from blocked-request counts.
  Chrome exposes no per-request byte total to extensions. Do not describe it
  as a measurement.
- **Never claim to show data used or data remaining.** 2.5 had a "data used"
  meter and a data budget; both were dropped in 2.6. Do not describe either.

A specific figure ("a page that would cost you 8 MB…") was drafted into this
listing and cut. The same invented benchmark had already been removed from
the welcome page once. Do not reintroduce a number that cannot be defended —
the popup shows each user their own real count instead.

Also do not claim the cookie handler "removes all cookie banners". It answers
the ones it recognises, hides the ones it cannot, and never accepts.

## Never list sites or apps by name

**2.5 was rejected on 2026-09-25 for keyword stuffing** ("Spam and Placement
in the Store", reference *Yellow Argon*). The reviewer's reason: "more than 5
entities in a section". Google's own example of the violation is "a long list
of the different sites on which the extension works", which describes what
2.5 added: eleven call and remote-desktop apps on one line, three chat apps on
the next, and five streaming sites on the line above. 2.3 and 2.4 passed with
the five streaming names, so five is the limit, not a safe number to aim for.

Google's guidance (Keyword spam FAQ): list **at most five** sites or brands,
and link to a page or put the list in a screenshot if more are needed. Also
keep **any single keyword under five uses**, the product's main purpose
included, and don't add general information that isn't about the extension.

The rule now: **name categories, not brands** ("popular video-call, messaging
and remote-desktop services"). Keep every list to three or four items, and
that goes for audience lists too, since "Who it is for" had eight. Before
resubmitting, count words: "data", "Chrome", "images" and "video" each
stay at 5 or fewer, and "Data Saver" doesn't need to appear at all, because
the store shows the name above the text. The full
per-site allowlists live in the code; the listing doesn't need to repeat them.
