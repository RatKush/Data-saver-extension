# Publishing to the Chrome Web Store

Written for this extension specifically: an **update** to a listing with a
live user base, not a first publish. The order matters — listing fields are
saved separately from the package, and submitting with half of them updated
is how a listing ends up describing a version that isn't live yet.

---

## 0. Before you open the dashboard

```sh
bash scripts/verify.sh
```

It must print **VERIFIED**. That covers manifest and rule integrity, the 2 KB
`regexFilter` limit, locale completeness, 94 unit tests, a real Edge run
**against the packaged zip**, filter freshness and a package audit.

What it does *not* cover, and you should eyeball once:

- The screenshots in `store-listing/screenshots/` still show the current UI.
  Regenerate with `python3 scripts/make-screenshots.py` after any visual change.
- `store-listing/description.txt` matches the features that actually ship.

---

## 1. Upload the package first

Developer Dashboard → the item → **Package** → *Upload new package* →
`dist/data-saver-extension-v2.3.zip`

Upload before touching any listing text. If the package is rejected for a
manifest problem you find out immediately, rather than after retyping copy.

The version in the manifest must be higher than the live one. The store
refuses a re-upload of the same version number, and there is no way to
overwrite a version once published.

---

## 2. Store listing tab

| Field | Source |
|---|---|
| Description | `store-listing/description.txt` — **paste verbatim** |
| Screenshots | `screenshots/01-savings.png`, `02-before-after.png`, `03-controls.png` |
| Small promo tile | `screenshots/promo-440x280.png` |

**The description field is plain text.** It does not render Markdown. That is
why the source is a `.txt` and not the `.md` beside it — pasting the `.md`
once put literal `**asterisks**` into the live listing.

Ignore `store-listing/screenshots to upload/`. Despite the name, those are
from August: old icon, old purple popup. They would sit beside the new frames
looking like a different product.

---

## 3. Privacy tab

| Field | Value |
|---|---|
| Single purpose | First section of `permission-justifications.md` |
| Permission justifications | One per permission, same file |
| Privacy policy URL | `https://data-saver-extension.pages.dev/privacy-policy` |
| Data usage | **No** to every category |

Note the privacy URL has no `.html` — Cloudflare Pages serves it
extensionless and redirects the other form.

"No" to every data row is accurate and worth being able to defend: Chrome
defines collection as *transmitted off the device*. This extension makes no
network requests of its own. The reasoning is written out at the end of
`permission-justifications.md` if a reviewer asks.

---

## 4. Consider a staged rollout

The dashboard offers a percentage rollout for updates. With a few thousand
live users this is worth using: ship to a slice, wait a few days, then widen.

The argument for it here is that the riskiest failure in this release is
silent. A broken popup or a ruleset that fails to enable produces no error a
user would report — they uninstall. A staged rollout means the churn signal
appears while most users are still on the old version.

If the dashboard doesn't offer it for this item, publish normally and watch
the numbers more closely in the first week.

---

## 5. Submit, then wait

Review is typically a few days and can be longer for a release that adds
content scripts.

### Where this release is most likely to get questioned

**Single purpose.** The policy requires one narrow purpose. This release adds
cookie-banner handling and pop-up blocking, which a reviewer could read as
unrelated features bolted on.

The answer, if it comes up: both reduce data. Consent platforms are
typically hundreds of kilobytes of third-party JavaScript, and a pop-up loads
an entire additional page. Both are off by default and both are described in
`permission-justifications.md` in those terms. Do not argue that they are
"privacy features" — that framing is what makes them look like a second
purpose.

**No new permissions.** Worth knowing in case a reviewer asks: managed policy
support uses a manifest key under the existing `storage` permission. The
permission set is unchanged since 2.1.

---

## 6. After it goes live

Watch, in this order of usefulness:

1. **One-star reviews in the first 72 hours.** The fastest signal that
   something broke. The review prompt starts firing at 15 days + 15,000
   blocked requests, so early ratings are unprompted — treat them as a smoke
   alarm rather than a verdict.
2. **Weekly active users.** A drop after rollout means the update broke
   something. v2.1 reached 96.4% adoption in fourteen days with no WAU dip;
   that is the shape to expect.
3. **The 30-day lagged cohort rate**, once there is enough of it. Never the
   same-day uninstall ratio — that measures your growth rate, not your
   product. Baseline is a 34.4% mean across a 29–39% band.

## Rolling back

There is no revert button. A published version cannot be withdrawn, and
users already updated stay updated.

Rolling back means rolling **forward**: fix, bump the version, publish again.
For a serious regression, the fastest path is to publish the previous
package's contents under a *higher* version number — `dist/` keeps the older
zips for exactly this.

This is the real reason to stage the rollout rather than the abstract one.

---

## Keep this current

If a step here turns out to be wrong or the dashboard moves, fix this file in
the same session. A stale checklist is worse than none, because it gets
followed.
