#!/usr/bin/env python3
"""
Refresh rules/ad-domains.json from Peter Lowe's ad & tracking server list
(https://pgl.yoyo.org/adservers/), a hand-vetted, weekly-revalidated domain
list. Converts it into a chrome.declarativeNetRequest static ruleset.

This is the fix for the recurring "ad-blocking accuracy degrades over time"
problem: ad/tracker domains rotate, so the list needs periodic refreshing
rather than one-off hand-edited regex patches. Re-run this script every
month or two (or whenever you notice more ads getting through) and reload
the unpacked extension.

Usage:
    python3 scripts/update-ad-domains.py
"""
import json
import re
import urllib.request
import pathlib

LIST_URL = (
    "https://pgl.yoyo.org/adservers/serverlist.php"
    "?hostformat=hosts&showintro=0&mimetype=plaintext"
)
OUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "rules" / "ad-domains.json"

# Rule priority for generated domain-block rules. Must stay HIGHER than the
# hand-curated allowlist rule in rules/ads.json (currently priority 20) so
# these exact, hand-vetted domain matches can never be overridden by the
# looser "cdn|static|assets|..." safety allowlist.
RULE_PRIORITY = 30

RESOURCE_TYPES = [
    "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
    "object", "xmlhttprequest", "ping", "csp_report", "media",
    "websocket", "webtransport", "webbundle", "other",
]

DOMAIN_LINE = re.compile(r"^\s*127\.0\.0\.1\s+([a-z0-9.\-]+)\s*$", re.IGNORECASE)


def fetch_domains(url: str) -> list[str]:
    req = urllib.request.Request(url, headers={"User-Agent": "data-saver-extension/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="ignore")

    domains, seen = [], set()
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = DOMAIN_LINE.match(line)
        if not m:
            continue
        d = m.group(1).lower()
        if d in ("localhost", "0.0.0.0") or d in seen:
            continue
        seen.add(d)
        domains.append(d)
    return domains


def build_rules(domains: list[str]) -> list[dict]:
    return [
        {
            "id": i,
            "priority": RULE_PRIORITY,
            "action": {"type": "block"},
            "condition": {"urlFilter": f"||{d}^", "resourceTypes": RESOURCE_TYPES},
        }
        for i, d in enumerate(domains, start=1)
    ]


def main() -> None:
    domains = fetch_domains(LIST_URL)
    rules = build_rules(domains)

    # Guard against ever exceeding Chrome's guaranteed-minimum static rule
    # count per ruleset (30,000) so the ruleset doesn't silently fail to load.
    if len(rules) > 29000:
        raise SystemExit(
            f"Refusing to write {len(rules)} rules — too close to Chrome's "
            "30,000 guaranteed-minimum static rules per ruleset limit."
        )

    OUT_PATH.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(rules)} domain-block rules to {OUT_PATH}")
    print("Reload the unpacked extension in chrome://extensions to pick up the change.")


if __name__ == "__main__":
    main()
