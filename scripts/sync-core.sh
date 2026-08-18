#!/usr/bin/env bash
# Re-vendor the chain core + supplier runtime from agents-marketplace.
# Usage: scripts/sync-core.sh <path-to-agents-marketplace-clone> [<ref>]
# Copies via `git archive` so the upstream working tree/branch is never touched.
set -euo pipefail
UPSTREAM="${1:?usage: sync-core.sh <upstream-clone-path> [<ref>]}"
REF="${2:-origin/main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

git -C "$UPSTREAM" fetch origin main --quiet
PIN=$(git -C "$UPSTREAM" rev-parse "$REF")

rm -rf "$ROOT/packages/shared" "$ROOT/agent"
mkdir -p "$ROOT/packages"
git -C "$UPSTREAM" archive "$REF" packages/shared | tar -x -C "$ROOT"
# supplier/ -> agent/ is the single path rename this template owns.
# Plain directory `mv` (not a `supplier/*` glob) so dotfiles (.dockerignore,
# .env.*.example) move too - a glob without dotglob silently drops them.
git -C "$UPSTREAM" archive "$REF" supplier | tar -x -C "$ROOT"
mv "$ROOT/supplier" "$ROOT/agent"

# Re-apply template-owned patches to vendored files. Conflict = hard stop.
if ls "$ROOT"/scripts/patches/*.patch >/dev/null 2>&1; then
  for p in "$ROOT"/scripts/patches/*.patch; do
    git -C "$ROOT" apply --verbose "$p"
  done
fi

cat > "$ROOT/VENDORED-FROM.md" <<EOF
# Vendored core

\`packages/shared/\` and \`agent/\` (upstream \`supplier/\`) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit \`$PIN\`
($(date -u +%Y-%m-%d)). Do not edit vendored files directly - change
\`scripts/patches/*.patch\` and re-run \`scripts/sync-core.sh\`.
EOF
echo "vendored at $PIN"
