# Lifecycle

What moves on-chain, in what order, and what the clock does at each step. Read this before you run anything with real AP3X behind it.

## Advert moves

Two moves, both yours:

- **Post** (`tx:post-advert`) creates the advert UTxO: your capability id, model string, price, processing SLA, and endpoint, live on-chain. Buyers discover and target this UTxO; nothing about a job happens without it.
- **Retire** (`tx:retire-advert`) spends it back, returns your bond, and takes the listing down. Do this when you're done serving a capability, not before. An escrow already posted against your advert does not care whether the advert is still live.

## Escrow: six moves

A job is one escrow UTxO that moves through a fixed set of states. Six transaction types move it; nothing else can.

```
Open      -- Claim         --> Claimed
Claimed   -- Submit        --> Submitted
Submitted -- Accept        --> Accepted    [terminal: buyer accepted, the quoted amount settles to the supplier]
Submitted -- Release       --> Released    [terminal: accept window missed, supplier settles unilaterally]
Open      -- Reclaim       --> Reclaimed   [terminal: buyer refunded, only after deliver-by]
Claimed   -- Reclaim       --> Reclaimed   [terminal: buyer refunded, only after deliver-by]
Open      -- RefundRevoked --> refunded    [terminal: the agent record is revoked or retired]
Claimed   -- RefundRevoked --> refunded    [terminal: the agent record is revoked or retired]
Submitted -- RefundRevoked --> refunded    [terminal: the agent record is revoked, in force at or before Submit]
```

Once a job reaches Submitted, Reclaim is no longer available. The buyer's only exit from there is Accept; the only other way the escrow closes is the supplier's Release, once the accept window has closed. See Timing below. RefundRevoked is the exception, and it exists only for escrows that name an agent (see below).

| Move | Who signs | From → to | Buyer/supplier get |
|---|---|---|---|
| Post (creates the escrow) | buyer | (none) → Open | locks price + both bonds |
| Claim | supplier | Open → Claimed | n/a |
| Submit | supplier | Claimed → Submitted | posts the signed result hash |
| Accept | buyer | Submitted → Accepted | the quoted amount and the supplier bond settle to the supplier; the buyer bond returns to the buyer |
| Reclaim | buyer | Open or Claimed → Reclaimed | buyer gets back price + both bonds |
| Release | supplier | Submitted → Released | the quoted amount + both bonds settle to the supplier |
| RefundRevoked | anybody | Open, Claimed or Submitted → refunded | buyer gets back price + both bonds |

Accepted and Released are both terminal settlements. The difference is who triggered it, when, and where the buyer bond goes: back to the buyer on Accept, to the supplier on Release. Reclaimed is the buyer's terminal escape hatch, only available before a result has been submitted.

## Escrows that name an agent

An advert posted with your `AGENT_ID` (README step 5) gives escrows that carry the same `agent_id`, plus a refund address: the buyer's own address. For those escrows:

- **Claim and Submit read your agent record.** They need the record to be Active and independent, to list your supplier key, and, for Claim, to list the escrow's capability. When the record fails a check, the agent answers `agent_not_eligible` and claims nothing.
- **The agent works only its own escrows.** An escrow that names another agent is refused (`wrong_agent`) before anything is claimed.
- **The receipt names the agent**: a ninth field, `agent_did = "did:vector:<agent_id>"`.
- **Value cap.** Nobody can claim an escrow whose price and bonds add up to more than 10,000 AP3X. The buyer gets it back by Reclaim after deliver-by.
- **Reclaim needs no buyer signature**, because the refund address is fixed in the escrow: anybody can submit it after deliver-by.
- **RefundRevoked.** When your record is revoked or retired, anybody can return an Open or Claimed escrow of your agent to its buyer at once. A Submitted escrow goes back the same way when the revocation is in force from a time at or before its Submit. See `docs/TRUST-LAYER.md`.

Escrows posted against a legacy advert keep the legacy rules and the 8-field receipt until the last of them closes.

## What the agent checks before the Claim

A buyer sends the job to `POST /v1/job` with the escrow reference and the request. The agent reads the escrow and your advert from the chain. It claims the escrow only when every check passes. A refused job costs no Claim, and the escrow stays Open. The buyer can Reclaim it after deliver-by.

Some checks compare the escrow with your own advert (`ADVERT_REF`). The answer to the buyer is a JSON body with the keys `error` and `reason` (both hold the code) and `message`:

| Code | Status | The escrow breaks this rule |
|---|---|---|
| `wrong_advert` | 409 | The escrow names another advert than `ADVERT_REF`. |
| `underpaid` | 409 | The quoted amount (`payment_lovelace`) of the escrow is below the advert price. Or the escrow output holds less than the quoted amount and both bonds of its datum. |
| `bond_mismatch` | 409 | A bond of the escrow is below the bond of the advert. |

An amount above the advert is not refused. The supplier gets more, not less. An escrow that comes from a vault can have a buyer bond above the advert bond, because the builder adds the minimum ada of the output to that bond.

## Timing

- **Deliver-by** = the time the escrow was posted + your advert's SLA (`max_processing_ms`) + a 30-second grace. Before deliver-by passes, a buyer cannot Reclaim an Open or Claimed escrow: the supplier still has time to work it. After deliver-by passes, the buyer can walk away with a full refund whether or not you've started.
- **The accept window is 600 seconds from Submit.** Once you submit a result, the buyer has ten minutes to Accept it. There is no buyer recovery from the Submitted state inside that window: an aborted or crashed buyer client still leaves the escrow sitting there, payable.
- **Boot guard:** the agent will not start serving the `custom` capability unless three costs fit inside that window: up to 60 seconds waiting out the Claim confirmation, then `SERVICE_TIMEOUT_MS` for your own service, then 30 seconds held back to build and land the Submit. In practice that means `SERVICE_TIMEOUT_MS` no higher than `ADVERT_MAX_PROCESSING_MS - 60000`. This is deliberate: a supplier whose own service budget can exceed what it advertised would claim jobs it can never submit in time. The buyer then reclaims each such escrow after deliver-by. The supplier posts no bond of its own, so it loses the Claim fee and the settlement that it would have got. Fix your `.env`, don't fight the guard.
- **The same arithmetic runs per job, not just at boot.** The agent gives your service whatever is left before deliver-by, minus that 30-second Submit reserve, capped at `SERVICE_TIMEOUT_MS`. A job claimed so late that nothing is left fails immediately as `deliver_by_too_close`, without your service being called: work that cannot be submitted in time settles for nobody. The advert's real SLA is also re-read from chain before every Claim, so an advert tighter than your configured value is refused rather than claimed.

## Release path

The chain supports Release. After the 600-second accept window closes on a Submitted job, the supplier can settle the job alone. The quoted amount and both bonds settle to the supplier. The buyer does nothing.

The template ships the command `tx:release-escrows` for this move. The command reads the escrow addresses on the chain and finds the Submitted escrows of your supplier key. It skips each escrow that is still inside its accept window. It releases the other escrows one at a time. Add `--dry-run` to list what it would release, and release nothing:

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/release-escrows.ts --dry-run
```

The command reads `SUPPLIER_PRIV_KEY_HEX`, `NETWORK_ID` and `OGMIOS_URL` from the environment. On mainnet it also needs `ESCROW_REF_UTXO` and `VECTOR_ZERO_TIME_MS`. It needs `IDENTITY_POLICY_ID` and `IDENTITY_ESCROW_REF_UTXO` to find and release the escrows that name an agent. The command runs in its own process and does not share the wallet lock of the agent. Run it when `/status` says `free`.

No timer runs the command. A Submitted escrow that the buyer does not accept stays in the escrow contract until you run the command.
