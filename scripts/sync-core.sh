#!/usr/bin/env bash
# Re-vendor the chain core + supplier runtime from agents-marketplace.
# Usage: scripts/sync-core.sh <path-to-agents-marketplace-clone> [<ref>]
# Copies via `git archive` so the upstream working tree/branch is never touched.
set -euo pipefail
UPSTREAM="${1:?usage: sync-core.sh <upstream-clone-path> [<ref>]}"
REF="${2:-origin/main}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# The vendored dirs are wiped and rebuilt below, and deleted template-owned
# files are restored FROM THE INDEX - so any uncommitted edit under them would
# be destroyed silently. Refuse to run until the tree is clean there.
DIRTY=$(git -C "$ROOT" status --porcelain -- agent packages/shared)
if [ -n "$DIRTY" ]; then
  echo "sync-core: refusing to run - uncommitted changes under agent/ or packages/shared/:" >&2
  echo "$DIRTY" >&2
  echo "commit or stash them first (this script rebuilds those trees from upstream)" >&2
  exit 1
fi

# Only origin/main is fetched, because that is the ref this template tracks by
# default. Any other <ref> - a tag, another branch, a bare commit - has to be
# present in the clone already, or the rev-parse below fails and nothing is
# touched. Fetch it yourself first if you are pinning to something else.
git -C "$UPSTREAM" fetch origin main --quiet
PIN=$(git -C "$UPSTREAM" rev-parse "$REF")

# The pin this tree currently sits on, read out of VENDORED-FROM.md before that
# file is rewritten at the end of this run. It is what makes "template-owned
# addition" decidable further down: a path the PREVIOUS pin did not have was
# never upstream's, so it is ours to restore. Without it, every missing path
# looks the same and an upstream deletion gets silently resurrected.
PREV_PIN=$(sed -n 's/.*at commit `\([0-9a-f]\{40\}\)`.*/\1/p' "$ROOT/VENDORED-FROM.md" 2>/dev/null | head -1)
if [ -n "$PREV_PIN" ] && git -C "$UPSTREAM" cat-file -e "${PREV_PIN}^{commit}" 2>/dev/null; then
  PREV_PATHS=$(git -C "$UPSTREAM" ls-tree -r --name-only "$PREV_PIN" -- supplier packages/shared \
    | sed 's|^supplier/|agent/|')
else
  PREV_PATHS=""
  echo "sync-core: no previous pin resolvable from VENDORED-FROM.md - restoring every deleted tracked path (pre-2026-08 behaviour)" >&2
fi

# agent/.env (or any other real, non-.example env file) holds live secrets
# that only ever live in the working tree - git never tracks them. The wipe
# below would delete them silently, so refuse first unless opted out.
if ls "$ROOT"/agent/.env* 2>/dev/null | grep -qv '\.example$'; then
  echo "WARNING: untracked env files under agent/ will be deleted by re-vendoring - move them first" >&2
  [ "${FORCE_SYNC:-0}" = "1" ] || exit 1
fi

# "$ROOT/supplier" is not a typo: a run that dies between the archive extract
# and the mv below leaves the upstream directory name behind, and the next run
# would then extract on top of it and mv a merged tree into place.
rm -rf "$ROOT/packages/shared" "$ROOT/agent" "$ROOT/supplier" "$ROOT/contracts/marketplace/plutus.json"
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
#
# Restore ONLY the template's own additions. Every path missing after the
# re-vendor is absent from the NEW ref by construction, so the new ref cannot
# tell the two cases apart; the PREVIOUS pin can. A path the previous pin also
# lacked was never upstream's, so it is a template addition and gets restored.
# A path the previous pin HAD is an upstream deletion at the new ref, and
# checking it back out would silently keep a file the pin no longer ships, in a
# tree whose whole promise is that it matches its pin. Report those instead.
# The one path rename this template owns (supplier/ -> agent/) is applied to
# the upstream listing before comparing.
git -C "$ROOT" diff --name-only --diff-filter=D -- agent packages/shared | while read -r deleted; do
  if printf '%s\n' "$PREV_PATHS" | grep -qxF -- "$deleted"; then
    echo "sync-core: $deleted was upstream at ${PREV_PIN:0:12} and is gone at ${PIN:0:12} - left deleted (upstream removed it)" >&2
  else
    git -C "$ROOT" checkout -- "$deleted"
  fi
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
