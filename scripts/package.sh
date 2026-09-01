#!/usr/bin/env bash
# Build a clean, Chrome-Web-Store-ready zip of the extension.
#
# Deliberately excludes:
#   _metadata/     - Chrome's own runtime-generated ruleset index cache
#                    (regenerated automatically; never part of the source)
#   scripts/       - dev-only build tooling (update-ad-domains.py etc.),
#                    not needed by the extension at runtime
#   store-listing/ - CWS submission material (privacy policy, permission
#                    justifications, description) - reference docs, not
#                    part of the shipped extension
#   .DS_Store      - macOS Finder cruft
#   README.md      - project doc, not needed inside the package
#   dist/          - avoid zipping our own previous output
#
# Usage: ./scripts/package.sh
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
OUT_DIR="dist"
OUT_FILE="$OUT_DIR/data-saver-extension-v${VERSION}.zip"

mkdir -p "$OUT_DIR"
rm -f "$OUT_FILE"

zip -r -q "$OUT_FILE" . \
  -x "_metadata/*" \
  -x "scripts/*" \
  -x "store-listing/*" \
  -x ".DS_Store" \
  -x "*/.DS_Store" \
  -x "README.md" \
  -x "dist/*" \
  -x ".git/*"

echo "Wrote $OUT_FILE"
unzip -l "$OUT_FILE"
