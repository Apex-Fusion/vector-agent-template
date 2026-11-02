# Vendored core

`packages/shared/`, `agent/` (upstream `supplier/`) and the compiled
validator blueprints the tx builders read (`contracts/marketplace/plutus.json`
for the legacy escrow and advert, `contracts/identity-marketplace/plutus.json`
for the escrow and advert that carry an `agent_id`) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit `d786fff5589bbef19943a90613531d2eb0111626`
(2026-11-02). Do not edit vendored files directly - change
`scripts/patches/*.patch` and re-run `scripts/sync-core.sh`. The blueprints
are pinned to this same commit on purpose: a blueprint from a different build
derives a different script address.
