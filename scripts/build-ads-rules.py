#!/usr/bin/env python3
"""
Regenerate rules/ads.json - the hand-curated ad/tracker keyword rules
(distinct from rules/ad-domains.json, which is the auto-fetched domain
list; see scripts/update-ad-domains.py for that one).

This is a generator, not a file to hand-edit: rules/ads.json is derived
output. To change the rule set, edit the word lists / KNOWN_FIRST_PARTY_CDNS
below and re-run:

    python3 scripts/build-ads-rules.py

Every rule here uses plain urlFilter (never regexFilter) - a prior version
used one big regexFilter alternation and silently failed to load because
RE2's compiled program exceeded Chrome's 2KB per-rule limit. Individual
urlFilter rules have no such ceiling.
"""
import json
import pathlib

OUT_PATH = pathlib.Path(__file__).resolve().parent.parent / "rules" / "ads.json"

# Domains that are a company's OWN first-party-adjacent CDN (different
# registrable domain, but dedicated infrastructure, not a real third
# party) - DNR's domainType:"thirdParty" is a pure eTLD+1 string
# comparison, it has no concept of "same company, different domain", so
# these need an explicit carve-out or generic keyword rules can take down
# a site's own JS bundles (confirmed live: "analytics" matched
# "AccountAnalytics" inside a webpack chunk filename served from
# abs.twimg.com while browsing x.com, crashing the whole app).
KNOWN_FIRST_PARTY_CDNS = ["twimg.com"]

RESOURCE_TYPES_BY_PRIORITY = {
    10: ["script", "xmlhttprequest", "image", "sub_frame", "media"],
    5: ["script", "image", "xmlhttprequest"],
    # priority 20 = the safety allowlist. Deliberately does NOT include
    # "image": its job is protecting legitimate CDN-hosted scripts/API
    # calls from the loose ad-keyword rules below. DNR priority is
    # evaluated globally across every enabled ruleset, not scoped per
    # file - with "image" included here, this rule's priority (20) beat
    # rules/images.json's blanket block (priority 1) for any image URL
    # containing "static"/"cdn"/etc, silently letting a large fraction of
    # ordinary site images through even with "Block Images" on. Confirmed
    # live: 12 of 38 images on bbc.com loaded from static.files.bbci.co.uk
    # despite images.json being enabled.
    20: ["script", "xmlhttprequest"],
    1: ["xmlhttprequest", "script"],
}

rules = []
next_id = 1

def add(term_list, priority, action_type, third_party_only):
    global next_id
    for term in term_list:
        condition = {
            "urlFilter": term,
            "isUrlFilterCaseSensitive": False,
            "resourceTypes": RESOURCE_TYPES_BY_PRIORITY[priority]
        }
        if third_party_only:
            condition["domainType"] = "thirdParty"
            condition["excludedRequestDomains"] = KNOWN_FIRST_PARTY_CDNS
        rules.append({
            "id": next_id,
            "priority": priority,
            "action": {"type": action_type},
            "condition": condition
        })
        next_id += 1

add(["adservice", "adserver", "analytics", "tracker", "pixel",
     "smetrics", "impression", "advertising"], 10, "block", third_party_only=True)

add(["/ads/", "/banner/", "/promo/", "/sponsor/",
     "/affiliate/", "/affiliates/", "/metric/", "/metrics/"], 5, "block", third_party_only=True)

add(["cdn", "static", "assets", "api", "fonts", "maps", "payment", "widget"], 20, "allow", third_party_only=False)

add(["tracking", "collect", "measure", "telemetry", "beacon",
     "stats", "data-logger"], 1, "block", third_party_only=True)

OUT_PATH.write_text(json.dumps(rules, indent=2) + "\n", encoding="utf-8")
print(f"wrote {len(rules)} rules to {OUT_PATH}")
