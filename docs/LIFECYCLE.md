# Lifecycle

What moves on-chain, in what order, and what the clock does at each step. Read this before you run anything with real AP3X behind it.

## Advert moves

Two moves, both yours:

- **Post** (`tx:post-advert`) creates the advert UTxO: your capability id, model string, price, processing SLA, and endpoint, live on-chain. Buyers discover and target this UTxO; nothing about a job happens without it.
- **Retire** (`tx:retire-advert`) spends it back, returns your bond, and takes the listing down. Do this when you're done serving a capability, not before. An escrow already posted against your advert does not care whether the advert is still live.

## Escrow: five moves

A job is one escrow UTxO that moves through a fixed set of states. Five transaction types move it; nothing else can.

```
Open      -- Claim   --> Claimed
Claimed   -- Submit  --> Submitted
Submitted -- Accept  --> Accepted    [terminal: buyer accepted, payment settles to the supplier]
Submitted -- Release --> Released    [terminal: accept window missed, supplier settles unilaterally]
Open      -- Reclaim --> Reclaimed   [terminal: buyer refunded, only after deliver-by]
Claimed   -- Reclaim --> Reclaimed   [terminal: buyer refunded, only after deliver-by]
```

Once a job reaches Submitted, Reclaim is no longer available. The buyer's only exit from there is Accept; the only other way the escrow closes is the supplier's Release, once the accept window has closed. See Timing below.

| Move | Who signs | From → to | Buyer/supplier get |
|---|---|---|---|
| Post (creates the escrow) | buyer | (none) → Open | locks price + both bonds |
| Claim | supplier | Open → Claimed | n/a |
| Submit | supplier | Claimed → Submitted | posts the signed result hash |
| Accept | buyer | Submitted → Accepted | payment settles to the supplier; both bonds return |
| Reclaim | buyer | Open or Claimed → Reclaimed | buyer gets back price + both bonds |
| Release | supplier | Submitted → Released | payment + both bonds settle to the supplier |

Accepted and Released are both terminal settlements. The difference is only who triggered it and when. Reclaimed is the buyer's terminal escape hatch, only available before a result has been submitted.

## Timing

- **Deliver-by** = the time the escrow was posted + your advert's SLA (`max_processing_ms`) + a 30-second grace. Before deliver-by passes, a buyer cannot Reclaim an Open or Claimed escrow: the supplier still has time to work it. After deliver-by passes, the buyer can walk away with a full refund whether or not you've started.
- **The accept window is 600 seconds from Submit.** Once you submit a result, the buyer has ten minutes to Accept it. There is no buyer recovery from the Submitted state inside that window: an aborted or crashed buyer client still leaves the escrow sitting there, payable.
- **Boot guard:** the agent will not start serving the `custom` capability unless three costs fit inside that window: up to 60 seconds waiting out the Claim confirmation, then `SERVICE_TIMEOUT_MS` for your own service, then 30 seconds held back to build and land the Submit. In practice that means `SERVICE_TIMEOUT_MS` no higher than `ADVERT_MAX_PROCESSING_MS - 60000`. This is deliberate: a supplier whose own service budget can exceed what it advertised would claim jobs it can never submit in time, forfeiting its bond for nothing. Fix your `.env`, don't fight the guard.
- **The same arithmetic runs per job, not just at boot.** The agent gives your service whatever is left before deliver-by, minus that 30-second Submit reserve, capped at `SERVICE_TIMEOUT_MS`. A job claimed so late that nothing is left fails immediately as `deliver_by_too_close`, without your service being called: work that cannot be submitted in time settles for nobody. The advert's real SLA is also re-read from chain before every Claim, so an advert tighter than your configured value is refused rather than claimed.

## Release path: status as of ship date

The chain supports Release: after the 600-second accept window closes on a Submitted job, the supplier can settle it unilaterally and collect payment plus both bonds, with no further action from the buyer. The transaction builder for it ships in the vendored core (`packages/shared/src/tx/escrow/release.ts`).

**This template does not ship a command for it.** There's no `tx:release` CLI, no automated watcher that fires one when a window closes. If a buyer misses the accept window today, your only path to that settlement is writing your own script against the vendored builder. Until that gap closes, the operating assumption is: buyers accept promptly, and suppliers should not count on Release as a safety net.
