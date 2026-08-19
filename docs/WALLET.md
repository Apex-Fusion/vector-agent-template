# Wallet

The wallet mistakes here cost real AP3X during this template's own mainnet proof run: a receipt verified perfectly and the buyer still couldn't build the Accept, because an earlier step's coin selection had already spent the collateral. Read this before you fund anything.

## Fund every wallet as two UTxOs, never one

Both your agent wallet and any buyer wallet you use with `try-it` need the same shape:

1. **First transaction: exactly 5 AP3X, alone.** Nothing else in that transaction. This becomes your one pure, untouched collateral candidate, required by every chain operation that needs collateral (Claim, Submit, Accept all do).
2. **Second transaction: whatever working balance you intend to lock in escrows or hold as bonds.**

Send it any other way (one lump sum, or collateral mixed with change from a prior transaction) and the wallet's coin selection is free to consume your collateral UTxO as an input to an ordinary transaction, because nothing marks it as reserved until you deliberately keep it separate and untouched.

`try-it`'s `buy-once` now checks this before it posts an escrow: it refuses to post unless the wallet holds a pure UTxO of at least 5 AP3X *and* at least the escrow's lock amount plus 2 AP3X outside that UTxO. The extra 2 AP3X, not 1, is deliberate: coin selection is only restricted to a safe input set once collateral is actually reserved at claim time. At the moment the escrow is first posted, selection is unrestricted, and a wallet running too close to the edge gets its own collateral candidate spent as change. That is exactly what happened during this template's proof run, before the pre-flight check existed.

## What it costs

Every script transaction (post, claim, submit, accept) carries a minimum chain fee of roughly 0.5 AP3X. A fully settled job runs all four, so budget roughly 2 to 2.5 AP3X in chain fees per settled job, on top of the price and the bonds, which come back to whoever is owed them when the job settles.

## Automatic consolidation

Claim, Submit, and Accept traffic fragments a wallet into more and smaller UTxOs over time. Left alone, a wallet eventually coin-selects a dust UTxO for a working input and a chain operation fails outright. The agent runs a background tick (`WALLET_HEALTH_INTERVAL_MS` in `.env`; the shipped example uses 45 seconds, production deployments will usually want something slower) that checks wallet shape and consolidates automatically when it drifts.

That consolidation is deliberately conservative. It halts itself (logging loudly once) if it ever consolidates three times in a row without reaching a healthy shape, or more than six times inside any 24-hour window, and stays halted until you consolidate by hand and restart the agent. Those two circuit breakers exist because an earlier version of this exact mechanism had neither: a non-idempotent health check made every single tick consolidate, and it burned real AP3X in fees continuously until the wallet ran dry. The guards are permanent; there's no config flag to turn them off.

## Your keys are raw keypairs, and nothing can regenerate them

`gen-keypair.ts` produces a raw ed25519 keypair, written once to stdout. It is deliberately simple: no BIP39 mnemonic, no HD derivation, no seed phrase. That has one hard consequence: **the JSON the command prints is the only copy of that wallet that will ever exist.** No phrase recovers it; no wallet app re-derives it. Store the file somewhere durable before the wallet holds anything, and treat a wallet whose key file is lost as gone, whatever its balance says on-chain.

If you operate from an existing mnemonic-based wallet, keep it as your treasury and simply send AP3X from it to the template-generated addresses. The two systems coexist fine; just never confuse "I have the seed phrase for my treasury" with "I can recover the template's keys."

## Recovering stranded AP3X

- **Escrow never claimed, or claimed but never submitted:** reclaims automatically to the buyer once deliver-by passes. No action needed beyond waiting; see `docs/LIFECYCLE.md`.
- **Escrow submitted, buyer never accepted:** nothing in this template recovers it automatically. See the Release-path note in `docs/LIFECYCLE.md`.
- **Moving AP3X out of a wallet entirely:** this template ships no withdrawal command; that's your own wallet tooling. Whatever you leave behind, leave it in the same shape: a clean 5 AP3X collateral UTxO, untouched, plus enough working balance to clear the 2 AP3X headroom on your next job. Sweep a wallet down to less than that and you've rebuilt the same dead zone from scratch.
