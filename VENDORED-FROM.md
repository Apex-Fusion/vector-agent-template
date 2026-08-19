# Vendored core

`packages/shared/`, `agent/` (upstream `supplier/`) and
`contracts/marketplace/plutus.json` (the compiled validator blueprint the tx
builders read) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit `c531e4678fb5928956b2a76b74f4b244320e5371`
(2026-08-18). Do not edit vendored files directly - change
`scripts/patches/*.patch` and re-run `scripts/sync-core.sh`. The blueprint is
pinned to this same commit on purpose: a blueprint from a different build
derives a different script address.
