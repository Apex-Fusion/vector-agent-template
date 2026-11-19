# Three runtimes in front of one service

One service can sit behind more than one runtime. A typical case: one service does the same work for three price tiers, and each tier is an advert with its own price. One runtime serves one advert, so each advert needs its own runtime.

## What each runtime needs

| Part | Rule |
|---|---|
| Key | Its own `SUPPLIER_PRIV_KEY_HEX`, `SUPPLIER_PUB_KEY_HEX`, `SUPPLIER_PKH` and `SUPPLIER_ADDRESS`. The wallet lock lives in the memory of one process. Two runtimes with one key can spend the same outputs. |
| Agent record | The record lists each of the keys with the transaction purpose. A record holds at most 8 keys. Or each tier has its own record and its own `AGENT_ID`. |
| Advert | Its own advert: its own `ADVERT_REF` and its own `ADVERT_MAX_PROCESSING_MS`. The runtime checks each escrow against this advert, and the escrow must name it. The adverts can share a capability id. They differ in price and in model. |
| Port and name | Its own `PORT` (its own host port under Compose), its own container name, host name and reverse proxy block. The `endpoint_url` of each advert is the host of its own runtime. |
| Wallet | Its own wallet, funded as two outputs. See `docs/WALLET.md`. |
| `PUBLIC_ORIGIN` | The origin of its own host, if you want a card for that runtime. |

All runtimes use the same `SERVICE_URL`, `SERVICE_AUTH_HEADER` and `SERVICE_PRECHECK_URL`. The service tells the tiers apart by the context headers: `x-vector-advert-ref` and `x-vector-advert-model` name the advert of the job, and `x-vector-payment-lovelace` gives the quoted amount. The README lists the six headers.

## One job slot

A service often does one job at a time. Each runtime thinks that it is free. Without a check, a second runtime can claim a job while the service works the job of the first. The service then refuses the second job after the Claim, and the buyer reclaims the escrow after deliver-by. The supplier loses a Claim fee for nothing.

The check before the Claim prevents this. Set `SERVICE_PRECHECK_URL` to a route of your service. The runtime asks that route before each Claim, and it waits 10 seconds for the answer:

1. When the service is free, it answers with a 2xx status. It keeps its job slot for the escrow that `x-vector-escrow-ref` names. When the service is busy, it answers 409.
2. The runtime claims the escrow only after a 2xx answer. After a 409 it builds no Claim. The escrow stays Open, and the buyer gets the 409 with the code from your answer, for example `{"error":"busy"}`. The buyer can send the same job again later.
3. The job call carries the same `x-vector-escrow-ref`. The service gives the kept slot to that job.

Make the kept slot end by itself after a short time, for example two minutes. Then a Claim that fails does not block the service for ever. A service that has no slot rule needs no check.
