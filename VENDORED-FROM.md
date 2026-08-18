# Vendored core

`packages/shared/` and `agent/` (upstream `supplier/`) are vendored from
https://github.com/Apex-Fusion/agents-marketplace at commit `c531e4678fb5928956b2a76b74f4b244320e5371`
(2026-08-18). Do not edit vendored files directly - change
`scripts/patches/*.patch` and re-run `scripts/sync-core.sh`.

Deliberate exclusion: upstream `supplier/` ships several deployment-specific `.env.*.example` files naming internal deployment targets. They are intentionally not tracked here (see `.gitignore`) - this template ships its own generic `.env.example` instead.
