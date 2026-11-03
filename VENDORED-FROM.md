# Vendored core

`packages/shared/`, `agent/` (upstream `supplier/`) and the compiled
validator blueprints the tx builders read (`contracts/marketplace/plutus.json`
for the legacy escrow and advert, `contracts/identity-marketplace/plutus.json`
for the escrow and advert that carry an `agent_id`) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit `4c95c3f7745f013f26a33e66e992989490ffb05e`
(2026-11-03). Do not edit vendored files directly - change
`scripts/patches/*.patch` and re-run `scripts/sync-core.sh`. The blueprints
are pinned to this same commit on purpose: a blueprint from a different build
derives a different script address.
