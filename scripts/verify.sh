#!/usr/bin/env bash
# One gate to run before every release.
#
# The v2.1 session found three bugs that had shipped undetected and lived in
# production for months — a regexFilter silently over Chrome's 2KB compiled
# limit, a rule that crashed X.com, and an allowlist leaking a third of images.
# None of them announced themselves. This script is the standing answer to that:
# everything that can fail silently gets asserted here.
#
#   ./scripts/verify.sh            full run, including the Edge browser test
#   ./scripts/verify.sh --fast     skip the browser test (~10s instead of ~40s)
#
# Exits non-zero on the first hard failure. Filter staleness is a WARNING, not a
# failure — it shouldn't block an urgent fix, but it should never be invisible.
set -uo pipefail
cd "$(dirname "$0")/.."

FAST=0
[ "${1:-}" = "--fast" ] && FAST=1

fail=0
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=1; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }

# ---------------------------------------------------------------------------
step "Manifest & rule integrity"

python3 - <<'PY' && ok "manifest.json parses and matches its files" || bad "manifest.json"
import json, os, sys
m = json.load(open('manifest.json'))
refs = {m['background']['service_worker'], m['action']['default_popup']}
refs |= set(m['action']['default_icon'].values()) | set(m['icons'].values())
refs |= {r['path'] for r in m['declarative_net_request']['rule_resources']}
missing = [f for f in sorted(refs) if not os.path.isfile(f)]
if missing:
    print('    missing: ' + ', '.join(missing)); sys.exit(1)
PY

# Chrome compiles each regexFilter and drops the WHOLE RULE if the compiled
# form exceeds 2KB — with no error anywhere. That is exactly how a rule went
# missing before, so it is asserted rather than trusted.
python3 - <<'PY' && ok "no regexFilter near Chrome's 2KB compiled limit" || bad "regexFilter size"
import glob, json, sys
bad = []
for path in glob.glob('rules/*.json'):
    if path.endswith('build-info.json'):
        continue
    for rule in json.load(open(path)):
        rx = rule.get('condition', {}).get('regexFilter')
        if rx and len(rx.encode()) > 1024:
            bad.append(f"{path} rule {rule.get('id')} ({len(rx.encode())} bytes)")
if bad:
    print('    ' + '\n    '.join(bad)); sys.exit(1)
PY

python3 - <<'PY' && ok "static rule counts within Chrome's limits" || bad "rule counts"
import glob, json, sys
total = 0
for path in glob.glob('rules/*.json'):
    if path.endswith('build-info.json'):
        continue
    n = len(json.load(open(path)))
    total += n
    if n > 29000:
        print(f'    {path}: {n} rules, too close to the 30,000 per-ruleset limit'); sys.exit(1)
print(f'    {total} rules across all rulesets')
PY

# ---------------------------------------------------------------------------
step "Source syntax"

syntax_ok=1
for f in *.js; do
  node --check "$f" 2>/dev/null || { bad "$f has a syntax error"; syntax_ok=0; }
done
[ "$syntax_ok" -eq 1 ] && ok "all extension JS parses"

# ---------------------------------------------------------------------------
step "Locales"

# Catches the three failures that have actually shipped here: a key missing
# from a translation, wrong-script leakage, and a placeholder translated away.
if locale_out=$(python3 "$(dirname "$0")/check-locales.py" 2>&1); then
  ok "$locale_out"
else
  printf '%s\n' "$locale_out"
  bad "locale check failed"
fi

# ---------------------------------------------------------------------------
step "Unit tests"

if node scripts/test-savings.mjs > /tmp/ds-unit.log 2>&1; then
  ok "$(tail -1 /tmp/ds-unit.log | tr -d '\n')"
else
  bad "unit tests failed"; sed 's/^/      /' /tmp/ds-unit.log | tail -20
fi

# ---------------------------------------------------------------------------
# Built here rather than at the end, so the browser test below can load the
# artifact that actually ships instead of the working tree.
if ./scripts/package.sh > /tmp/ds-pkg.log 2>&1; then
  ZIP=$(ls -t dist/*.zip | head -1)
  PACKAGED=1
else
  ZIP=""
  PACKAGED=0
fi

# ---------------------------------------------------------------------------
step "Browser test (Microsoft Edge)"

if [ "$FAST" -eq 1 ]; then
  warn "skipped (--fast)"
elif [ ! -x "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" ]; then
  warn "Edge not installed — skipping the only test that exercises real DNR blocking"
else
  # Run against the EXTRACTED ZIP, not the working tree. The zip is built from
  # an explicit include list, so a file that exists on disk but is missing from
  # that list would pass a working-tree test and then break for real users.
  # Test the artifact.
  ZIPDIR="$(mktemp -d)"
  if [ -f "$ZIP" ] && unzip -q "$ZIP" -d "$ZIPDIR"; then
    TARGET="--dir=$ZIPDIR"
    WHAT="packaged zip"
  else
    TARGET=""
    WHAT="working tree (no zip built yet)"
  fi

  if python3 scripts/e2e-edge.py $TARGET > /tmp/ds-e2e.log 2>&1; then
    ok "$(grep -E '^counted' /tmp/ds-e2e.log | sed 's/counted *: //')  [$WHAT]"
  else
    bad "browser test failed against the $WHAT"
    sed 's/^/      /' /tmp/ds-e2e.log | tail -20
  fi
  rm -rf "$ZIPDIR"
fi

# ---------------------------------------------------------------------------
step "Filter freshness"

python3 - <<'PY'
import datetime, json, os, sys
p = 'rules/build-info.json'
if not os.path.isfile(p):
    print('  \033[33mwarn\033[0m  no rules/build-info.json — run scripts/update-ad-domains.py'); sys.exit(0)
info = json.load(open(p))
built = datetime.date.fromisoformat(info['built'])
age = (datetime.date.today() - built).days
msg = f"blocklist built {info['built']} ({age} days ago, {info['rules']} rules)"
# Rules only refresh on a store release, so the real cadence is monthly.
if age > 35:
    print(f'  \033[33mwarn\033[0m  {msg} — STALE, run scripts/update-ad-domains.py before releasing')
else:
    print(f'  \033[32mok\033[0m    {msg}')
PY

# ---------------------------------------------------------------------------
step "Package audit"

if [ "$PACKAGED" -eq 1 ]; then
  ok "$(tail -1 /tmp/ds-pkg.log)"
  # The packager builds from an allowlist, but assert the negative too: private
  # analytics exports were being shipped inside the extension until 2026-09-14.
  zip="$ZIP"
  if unzip -Z1 "$zip" | grep -qiE '\.csv$|\.xlsx$|^\.|/\.'; then
    bad "package contains data or dotfiles that must not ship"
    unzip -Z1 "$zip" | grep -iE '\.csv$|\.xlsx$|^\.|/\.' | sed 's/^/      /'
  else
    ok "no analytics exports or dotfiles in the package"
  fi
else
  bad "packaging failed"; sed 's/^/      /' /tmp/ds-pkg.log | tail -20
fi

# ---------------------------------------------------------------------------
if [ "$fail" -eq 0 ]; then
  printf '\n\033[32mVERIFIED\033[0m — safe to upload\n\n'
else
  printf '\n\033[31mFAILED\033[0m — do not release\n\n'
fi
exit "$fail"
