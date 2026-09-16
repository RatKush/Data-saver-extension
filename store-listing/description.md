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

Terms it deliberately covers, because they are what this audience types:
save mobile data, reduce data usage, data saver, block images, stop
autoplay video, low bandwidth, limited/capped/prepaid data, metered
connection, and Chrome's retired Lite Mode, which people search for by name
looking for a replacement.

The "Common questions" section is there for answer engines rather than
keyword matching — the headings are phrased the way people actually ask, so
the answers are quotable as-is.

## Two claims that must never be overstated

- **The savings meter is an ESTIMATE** derived from blocked-request counts.
  Chrome exposes no per-request byte total to extensions. Do not describe it
  as a measurement.
- **The data budget does not track consumption** and must never be described
  as showing data remaining. It paces from the allowance and the date only.

A specific figure ("a page that would cost you 8 MB…") was drafted into this
listing and cut. The same invented benchmark had already been removed from
the welcome page once. Do not reintroduce a number that cannot be defended —
the popup shows each user their own real count instead.

Also do not claim the cookie handler "removes all cookie banners". It answers
the ones it recognises, hides the ones it cannot, and never accepts.
