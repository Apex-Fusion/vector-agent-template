#!/usr/bin/env bash
# Canon lint for public prose. Scans README.md and docs/ (not code, not vendored).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FILES=$(find "$ROOT" -maxdepth 2 -name "*.md" -not -path "*/node_modules/*" -not -path "*/packages/*" -not -path "*/agent/*")
BANNED='earn AP3X|governance|Blagojevic|Cejtlin|Nedeljkovic|Fragiskatos|datalab|chandra| TPS|throughput|accuracy of [0-9]|% accuracy'
if grep -RniE "$BANNED" $FILES; then
  echo "FAIL: banned term found in public prose" >&2; exit 1
fi
echo "prose lint clean"
