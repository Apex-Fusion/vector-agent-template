#!/usr/bin/env bash
# Canon lint for public prose in a repo that is about to be public.
#
# Scans EVERY tracked text file, not just markdown: a banned term is exactly as
# public in a TypeScript comment, a compose file or a workflow as it is in a
# paragraph of the README.
#
# Excluded, deliberately:
#   packages/shared/**, agent/**, contracts/**  the vendored upstream tree.
#     That content is ALREADY public in Apex-Fusion/agents-marketplace at the
#     commit VENDORED-FROM.md pins, this template must not hand-edit it (house
#     rule: vendored files change only through scripts/patches/*.patch), and its
#     comments are upstream's editorial choice rather than this repo's.
#   this script itself                          the banned list matches itself.
#
# Two exceptions to those exclusions, both scanned:
#   the template-owned files that live inside agent/ (executor/,
#     customJobRunner*, routes/custom*, config.custom.test.ts). This repo
#     authored those, so this repo answers for their prose.
#   the ADDED lines of scripts/patches/*.patch. A patch's context lines are
#     verbatim upstream text; its added lines are ours and land in the
#     vendored tree, which is the one way template prose reaches those files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Name spellings include their diacritic forms: the plain-ASCII variant alone
# misses the way these names are normally written.
BANNED='earn AP3X|governance|Blagojevi(c|ć)|Cejtlin|Nedeljkovi(c|ć)|Mu(z|ž)evi(c|ć)|Fragiskatos|datalab|chandra| TPS|throughput|accuracy of [0-9]|% accuracy'
OWNED_INSIDE_VENDORED='^agent/src/(executor/|customJobRunner|routes/custom|config\.custom\.test\.ts)'

fail=0

FILES=$(
  {
    git ls-files | grep -vE '^(packages/shared/|contracts/|agent/|scripts/patches/)' || true
    git ls-files | grep -E "$OWNED_INSIDE_VENDORED" || true
  } | grep -vE '^scripts/lint-public-prose\.sh$' | sort -u
)

if [ -n "$FILES" ]; then
  # -I skips binaries, -n reports the line so the failure is actionable.
  if grep -nIiE "$BANNED" -- $FILES; then
    echo "FAIL: banned term in a template-owned file" >&2
    fail=1
  fi
fi

for p in scripts/patches/*.patch; do
  [ -e "$p" ] || continue
  if grep -hE '^\+' "$p" | grep -niE "$BANNED"; then
    echo "FAIL: banned term on a line added by $p" >&2
    fail=1
  fi
done

[ "$fail" -eq 0 ] || exit 1
echo "prose lint clean ($(printf '%s\n' "$FILES" | wc -l | tr -d ' ') tracked files + patch additions)"
