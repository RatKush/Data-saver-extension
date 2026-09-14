#!/usr/bin/env bash
# Build a clean, Chrome-Web-Store-ready zip of the extension.
#
# This builds from an EXPLICIT INCLUDE LIST, not by zipping the folder and
# excluding known junk. The old denylist approach shipped whatever happened to
# be sitting in the project root — which on 2026-09-14 meant the Chrome Web
# Store analytics exports (install counts by region, weekly users) were being
# packaged into the extension and would have been published, downloadable by
# anyone. A denylist is only ever as current as the last person who remembered
# to update it; an allowlist fails closed.
#
# Adding a file to the extension means adding it here. The audit at the end
# refuses to write a zip containing anything not on this list.
#
# Usage: ./scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

INCLUDE=(
  manifest.json
  background.js
  popup.html
  popup.js
  welcome.html
  welcome.js
  savings_counter.js
  hide_broken_images.js
  stop_all_media.js
  force_open_shadow_dom.js
  icons/icon16.png
  icons/icon48.png
  icons/icon128.png
  rules/ads.json
  rules/ad-domains.json
  rules/images.json
  rules/media.json
)

# Locales are discovered rather than listed: there are 25 and growing, and a
# hand-maintained list would silently drop one. The audit below still asserts
# the zip contains exactly what this array resolves to.
while IFS= read -r loc; do INCLUDE+=("$loc"); done < <(find _locales -name messages.json | sort)

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/data-saver-extension-v${VERSION}.zip"

# Every file the manifest references must actually exist, or Chrome rejects the
# upload with an error that doesn't name the missing file.
missing=0
for f in "${INCLUDE[@]}"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: listed file is missing: $f" >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || { echo "Refusing to package with missing files." >&2; exit 1; }

# Cross-check the include list against what the manifest actually asks for, so
# a newly added ruleset or content script can't be silently left out.
python3 - "$@" <<'PY'
import json, sys, os
m = json.load(open('manifest.json'))
needed = {m['background']['service_worker'], m['action']['default_popup']}
needed |= set(m['action']['default_icon'].values()) | set(m['icons'].values())
needed |= {r['path'] for r in m['declarative_net_request']['rule_resources']}
missing = [f for f in sorted(needed) if not os.path.isfile(f)]
if missing:
    print('ERROR: manifest references files that do not exist: ' + ', '.join(missing), file=sys.stderr)
    sys.exit(1)
PY

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

zip -q "$OUT_FILE" "${INCLUDE[@]}"

# Audit: the zip must contain exactly the include list, nothing more. This is
# the gate that would have caught the analytics-export leak.
actual=$(unzip -Z1 "$OUT_FILE" | sort)
expected=$(printf '%s\n' "${INCLUDE[@]}" | sort)

if [ "$actual" != "$expected" ]; then
  echo "ERROR: package contents do not match the include list." >&2
  echo "Unexpected or missing entries:" >&2
  diff <(echo "$expected") <(echo "$actual") >&2 || true
  rm -f "$OUT_FILE"
  exit 1
fi

echo "Wrote $OUT_FILE"
echo "$actual" | sed 's/^/  /'
echo
echo "$(echo "$actual" | wc -l | tr -d ' ') files, $(du -h "$OUT_FILE" | cut -f1) total"
