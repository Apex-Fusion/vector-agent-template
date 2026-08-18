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

rm -rf "$ROOT/packages/shared" "$ROOT/agent" "$ROOT/contracts/marketplace/plutus.json"
mkdir -p "$ROOT/packages"
git -C "$UPSTREAM" archive "$REF" packages/shared | tar -x -C "$ROOT"
# supplier/ -> agent/ is the single path rename this template owns.
# Plain directory `mv` (not a `supplier/*` glob) so dotfiles (.dockerignore,
# .env.*.example) move too - a glob without dotglob silently drops them.
git -C "$UPSTREAM" archive "$REF" supplier | tar -x -C "$ROOT"
mv "$ROOT/supplier" "$ROOT/agent"
# The compiled validator blueprint. Both live tx builders resolve it from
# <repo>/contracts/marketplace/plutus.json - loadBlueprint() for the script
# ADDRESS (postEscrow/postAdvert) and loadEscrowScript() for the compiled
# code (Claim/Submit/Accept/Reclaim) - so without it the template cannot build
# an escrow tx at all. It must stay pinned to the same upstream commit as the
# code: a stale blueprint derives a DIFFERENT script address.
git -C "$UPSTREAM" archive "$REF" contracts/marketplace/plutus.json | tar -x -C "$ROOT"

# The wipe above removes agent/ wholesale, which also takes the template's OWN
# files living under it - the custom-kind runtime (executor/, routes/custom.ts,
# customJobRunner.ts) and its tests are ADDITIONS, not patches, so nothing in
# scripts/patches/ recreates them. Restore exactly what the wipe deleted, by
# path, from the index: never a blanket `checkout -- agent`, which would also
# revert genuinely new upstream content and hide the re-vendor.
git -C "$ROOT" diff --name-only --diff-filter=D -- agent packages/shared | while read -r deleted; do
  git -C "$ROOT" checkout -- "$deleted"
done

# Re-apply template-owned patches to vendored files. Conflict = hard stop.
if ls "$ROOT"/scripts/patches/*.patch >/dev/null 2>&1; then
  for p in "$ROOT"/scripts/patches/*.patch; do
    git -C "$ROOT" apply --verbose "$p"
  done
fi

cat > "$ROOT/VENDORED-FROM.md" <<EOF
# Vendored core

\`packages/shared/\`, \`agent/\` (upstream \`supplier/\`) and
\`contracts/marketplace/plutus.json\` (the compiled validator blueprint the tx
builders read) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit \`$PIN\`
($(date -u +%Y-%m-%d)). Do not edit vendored files directly - change
\`scripts/patches/*.patch\` and re-run \`scripts/sync-core.sh\`. The blueprint is
pinned to this same commit on purpose: a blueprint from a different build
derives a different script address.
EOF
echo "vendored at $PIN"
# The wipe took packages/shared/node_modules and agent/node_modules with it, so
# workspace deps are unresolvable until the store is re-linked.
echo "next: corepack pnpm install"
