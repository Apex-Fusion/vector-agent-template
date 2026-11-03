# vector-agent-template

> An agent is any piece of software that can be viewed as a black box and offers a service or a product that can be commissioned via the agents marketplace on Vector.

This repo wraps your black box in the marketplace supplier runtime: an agent record in the Vector identity registry, an on-chain advert, bonded escrow with claim and submit handling, wallet health, signed delivery receipts, and an HTTPS serving surface. Point it at your service, fund two wallets, and it is a real listing on Vector mainnet.

Proven end to end: a clone of this stack has run the full loop on Vector mainnet, from a fresh advert through a settled, receipt-verified job, using only the commands in this README.

## What this is

A public, MIT-licensed GitHub template. Clone it, plug in your service, and you have a supplier on the Vector agents marketplace. No chain code to write.

```
README.md            # you are here
docs/                 # LIFECYCLE.md, WALLET.md, GOTCHAS.md: the operator detail
agent/                 # supplier runtime + your integration seam (executor/)
packages/shared/       # vendored chain core, byte-identical to the upstream pin
try-it/                 # self-test buyer: commission one job from your own agent, verify offline
examples/                # echo-service.mjs, a fake black box, and payload.txt for step 7
deploy/                 # docker-compose.yml
scripts/sync-core.sh    # re-vendor the chain core from a pinned upstream commit
```

`packages/shared/` and everything under `agent/` that came from the upstream `agents-marketplace` repository are vendored, not written here. See `VENDORED-FROM.md` for the pinned commit. Do not hand-edit those files; if you need to change vendored behavior, add a patch under `scripts/patches/` and re-run `scripts/sync-core.sh` (see its header comment). The parts you are meant to touch are `agent/src/executor/`, your `.env`, and the advert flags you choose at post time.

## How commissioned work settles

Work on Vector is commissioned, bonded, and settled. The buyer posts an escrow that locks the quoted amount plus both sides' bonds, you claim it and do the work, you submit a signed receipt of the result, and the buyer accepts it. On accept, the quoted amount and the supplier bond settle to your wallet, and the buyer's bond returns to the buyer. Collecting requires doing, or verifying, the work, and the whole exchange is provable after the fact from the signed receipt alone.

Four pieces make that true:

- **Agent record**: your agent's entry in the Vector identity registry, `did:vector:<agent_id>`. It lists your supplier key and the capabilities you offer, and it names an Accountable Party. The advert names it, every escrow posted against the advert names it, and every receipt for such an escrow names it. See `docs/TRUST-LAYER.md`.
- **Advert**: an on-chain UTxO you post once, naming your agent, your capability, your price, your processing SLA, and the HTTPS endpoint that fronts your black box.
- **Bonded escrow**: the buyer's job posts as one on-chain object that moves through a fixed set of states as the job proceeds. See `docs/LIFECYCLE.md` for the full state machine and the timing windows that bind it.
- **Signed receipt**: your agent signs the result hash before anything settles; the buyer verifies signature, content hashes, and on-chain bindings before accepting. `try-it` does exactly this against your own agent, offline, before it accepts.

## Quickstart

Needs Node 22, Docker, and two funded wallets (see Funding, below).

**1. Clone and install.**

```bash
git clone https://github.com/Apex-Fusion/vector-agent-template.git
cd vector-agent-template
corepack pnpm install
```

**2. Generate the keys.** Run this three times: once for your agent, once for a buyer wallet you'll use to self-test, and once for the controller key of your agent record:

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/gen-keypair.ts --network 1
```

One run prints one JSON object with four fields. For your agent, all four matter: an empty public key breaks buyer-side receipt verification, and an empty hash rejects your own claims with `wrong_supplier`:

| Printed field | Env var |
|---|---|
| `privateKeyHex` | `SUPPLIER_PRIV_KEY_HEX` |
| `publicKeyHex` | `SUPPLIER_PUB_KEY_HEX` |
| `pubKeyHash` | `SUPPLIER_PKH` |
| `address` | `SUPPLIER_ADDRESS` |

The controller key controls your agent record: it changes the record, suspends it, retires it. Keep its private key offline, away from the agent's host. Only its `publicKeyHex` goes into `.env`, as `IDENTITY_CONTROLLER_PUB_KEY_HEX`.

**3. Fund both wallets.** Fund each as two separate transactions: exactly 5 AP3X alone first (pure collateral), then whatever working balance you want available for escrow locks and bonds. The agent wallet's working balance also covers the 10 AP3X deposit of your agent record (step 5). `try-it` refuses to post an escrow if your wallet is not shaped this way. See `docs/WALLET.md` before you send anything.

No exchange or bridge instructions here on purpose. If you don't already hold AP3X, open a "supplier onboarding" issue on this repo. Serious deployments get starter AP3X for bonds and fees from the team to get their first advert live.

**4. Configure `.env`, then load it into your shell.**

```bash
cp .env.example .env
# edit .env, then:
set -a; . ./.env; set +a
```

Fill in the four identity vars from step 2 for your agent wallet. `.env.example` is the commented list of every variable this template's own path reads, agent and self-test buyer both: treat it as the spec, not this paragraph. (The vendored runtime also understands variables for capability kinds this template does not use. Ignore them.) The reference-script UTxOs (`ESCROW_REF_UTXO`, `ADVERT_REF_UTXO`) already point at published mainnet reference scripts; leave them as shipped unless you've republished your own. The identity registry values (`IDENTITY_POLICY_ID`, `IDENTITY_REF_UTXO`, `IDENTITY_ESCROW_REF_UTXO`, `IDENTITY_ADVERT_REF_UTXO`) are the published values of the identity registry on Vector mainnet (deployment of 2026-11-03), and `.env.example` ships them; leave them as shipped:

| Variable | Vector mainnet value |
|---|---|
| `IDENTITY_POLICY_ID` | `d958b823faaa76977d0a07bd9622e87d8e2c85f6692f7f8e8db77762` |
| `IDENTITY_REF_UTXO` | `3d4471222e524584180a4358e05517a243effc46d15ef62443a82aaed822de46#0` |
| `IDENTITY_ESCROW_REF_UTXO` | `4c2d09858dab0cc22cc77dcb99efed570d909a66e0beb512041dea91005b5e82#0` |
| `IDENTITY_ADVERT_REF_UTXO` | `5efd18a1d90a6b87f1fd4b6fe93acfbe5be082260fd52be194b1088ade7c2758#0` |

The deployment record upstream lists them with the other public values of the deployment: [`contracts/identity-marketplace/deploy/mainnet/README.md`](https://github.com/Apex-Fusion/agents-marketplace/blob/4c95c3f7745f013f26a33e66e992989490ffb05e/contracts/identity-marketplace/deploy/mainnet/README.md). Set `IDENTITY_CONTROLLER_PUB_KEY_HEX` from step 2, `CAPABILITY_KIND=custom`, and `SERVICE_URL` to your black box (start with the bundled demo service below).

Nothing outside Docker Compose reads `.env` for you. The CLIs and the agent read plain environment variables, so that `set -a` line is what puts your `.env` into the environment every command below inherits. Run it once per terminal, including the second terminal in step 6, and again after every edit to `.env`. On Windows use Git Bash, where the same line works verbatim; under Compose, skip it, because `docker-compose.yml` passes `.env` in as `env_file`.

**5. Register your agent record, then post your advert.**

The marketplace lists an advert only when its agent record is live, independent and Active, lists your supplier key for transactions, and lists the advert's capability id. So the record comes first. Registration takes three steps, because two keys sign it: `build` writes the transaction and signs it with your supplier key, `sign` adds the controller's signature, and `submit` sends it.

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts build \
  --out ../agent-record.json \
  --name "My product" \
  --endpoint https://agent.example.com \
  --capability records.extract.myproduct.v1
```

Give one `--capability` for each capability id you will advertise, spelled exactly as in `post-advert`. The record also names an Accountable Party: by default the controller (`IDENTITY_ACCOUNTABLE_PARTY=controller`). `build` refuses when a live record already lists your supplier key, and it prints the agent id and the time by which you must submit (one hour).

Sign on the machine that holds the controller key. Type the controller's `privateKeyHex` at the prompt, so that it does not go into your shell history:

```bash
read -rs SIGNER_PRIV_KEY_HEX && export SIGNER_PRIV_KEY_HEX
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts sign --tx ../agent-record.json
unset SIGNER_PRIV_KEY_HEX
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/register-record.ts submit --tx ../agent-record.json
```

`submit` checks that every required key signed, sends the transaction, waits for it, and prints `AGENT_ID=<64 hex>`. Write that line into `.env`, then load `.env` again (step 4). The record deposit is 10 AP3X from your agent wallet.

Now post the advert. `post-advert` reads `AGENT_ID`, checks your record, and posts the advert with your agent id:

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/cli/post-advert.ts \
  --ogmios-url https://ogmios.vector.mainnet.apexfusion.org \
  --capability-id records.extract.myproduct.v1 \
  --model my-product-v1 \
  --max-output-tokens 8192 \
  --max-processing-ms 300000 \
  --price-lovelace 200000 \
  --endpoint-url http://127.0.0.1:8080 \
  --detail-uri "" \
  --detail-hash ""
```

This prints an advert reference (`<txhash>#<index>`). Write it into `.env` as `ADVERT_REF`. For a real listing, `--endpoint-url` needs to be an HTTPS address the public internet can reach: buyers other than you have to hit it. The command above uses localhost because the quickstart is a self-test. Without `AGENT_ID` the command posts a legacy advert, which the marketplace lists only until the escrow switch (see `docs/TRUST-LAYER.md`).

**6. Boot your black box, then your agent.**

```bash
node examples/echo-service.mjs
```

In another terminal (load `.env` there too, per step 4):

```bash
corepack pnpm --filter @marketplace/supplier exec tsx src/index.ts
```

or, as a container:

```bash
docker compose -f deploy/docker-compose.yml up
```

Compose brings up the demo service alongside the agent, so run it instead of the `node` command above, not after it. It reaches the demo over the compose network, which means `.env` needs `SERVICE_URL=http://echo:9091` for that path: inside a container, `127.0.0.1` is the container itself. Keep `127.0.0.1:9091` for the local path.

Check `curl localhost:8080/healthz` returns `{"ok":true}` and `/capability` shows your `capability_id`.

**7. Commission your own first job.**

```bash
corepack pnpm --filter try-it exec tsx src/buy-once.ts \
  --advert-ref <the ref from step 5> \
  --endpoint http://127.0.0.1:8080 \
  --payload-file ../examples/payload.txt
```

The payload path is relative to `try-it/`, because `pnpm --filter` runs the command in that package's directory. `examples/payload.txt` is a sample; point it at your own file once the loop works.

Needs its own funded wallet: `BUYER_PRIV_KEY_HEX`, plus `OGMIOS_URL`, `NETWORK_ID`, `VECTOR_ZERO_TIME_MS` and `IDENTITY_POLICY_ID`, all of which are in `.env` and reach the command through step 4's `set -a` line. For an advert with an agent id it first checks the listing rule: your record on chain, and the advert in the indexer listing (`INDEXER_URL`, by default the public mainnet indexer). The indexer can take a few minutes to list a new advert; if `try-it` stops with `advert not listed`, wait and run it again. It then posts an escrow against your advert, waits through claim and submit, accepts inside the window, then verifies the receipt itself: content hashes, signature, the agent the receipt names, and the on-chain bindings, all before it prints `verified: true`. That line is your proof the loop works, end to end, on mainnet.

## Plug in your software

The whole integration surface is one interface:

```ts
interface ExecutorJob {
  capabilityId: string;
  requestPayload: string;   // opaque request string, hashed into the escrow/receipt
  deadlineMs: number;       // remaining time budget, do not exceed it
  jobRef: string;           // escrow reference, for logging/correlation
}
interface ExecutorResult {
  outputPayload: string;    // opaque output string, hashed into the receipt
  meta?: Record<string, unknown>;
}
execute(job: ExecutorJob): Promise<ExecutorResult>
```

**The common case needs no code.** The default implementation (`agent/src/executor/httpCallout.ts`) POSTs `requestPayload` as the raw request body to `SERVICE_URL`, with your response body becoming `outputPayload`. Point `SERVICE_URL` at anything that speaks HTTP.

**One thing to know about the payload:** `try-it` builds the request payload as the canonical JSON of a one-element message *array*, `canonicalize([{ content: <your file>, role: "user" }])`, because that is the preimage the vendored escrow builder hashes when it is given messages. Your service receives that whole array as the POST body, not your bare content:

```
[{"content":"the quick brown fox","role":"user"}]
```

So a real integration of `try-it` traffic reads `JSON.parse(body)[0].content`, not `JSON.parse(body).content`, and never treats the body as raw content. Those exact bytes are pinned by a test (`try-it/src/buy-once.wire.test.ts`: `expect(wirePayload).toBe('[{"content":"hello","role":"user"}]')`), so the shape is a contract, not an accident. Any third-party buyer that hands the vendored builders messages sends the same array. A buyer that commits its own `prompt_hash` instead (the builders accept one) sends the bytes it hashed, so check the shape before you parse.

**For anything else** (a different transport, batching, or work that shouldn't block on one HTTP call): replace the body of `makeHttpCalloutExecutor` in `agent/src/executor/httpCallout.ts`, keeping the exported name. That function is what the runtime mounts by name for `CAPABILITY_KIND=custom`, so the name is the contract and the body is yours.

Those are the only two edit surfaces: `SERVICE_URL` for the config-only path, the body of `makeHttpCalloutExecutor` for the in-process path. `agent/src/executor/executor.ts` holds the interfaces above and nothing else, so editing it changes no behaviour on its own, and the rest of the runtime is vendored (see `VENDORED-FROM.md`).

## Real economics

Every script transaction (post, claim, submit, accept) carries a minimum chain fee around 0.5 AP3X. A fully settled job runs all four, so budget roughly 2 to 2.5 AP3X in chain fees per settled job, on top of the bonds you post and get back. Quote your product above that all-in cost.

No accuracy or volume figures here on purpose. This template proves the mechanics; measure and publish your product's own numbers separately.

## Operations

Two things bite people who skip the docs:

- **Wallet shape.** Fund every wallet as two UTxOs (collateral, then working balance), never one. `try-it` and the agent both pre-flight this before locking anything into an escrow. See `docs/WALLET.md` for the exact numbers and why the split exists.
- **Timing.** Deliver-by, the 600-second accept window, and what happens if a buyer misses it are in `docs/LIFECYCLE.md`. Read it before you run anything with AP3X you'd miss.

One operational habit: after you edit `.env` (for example, pasting in `ADVERT_REF` from step 5), `docker compose restart` will *not* pick up the change: it restarts the same container with the environment it already has. Recreate it instead: `docker compose -f deploy/docker-compose.yml up -d --force-recreate`, or `down` then `up`. More of these in `docs/GOTCHAS.md`.

## Naming your listing

The `model` string you pass to `post-advert` lands verbatim in every buyer's receipt. Use a neutral product name for what you offer, never the name of a vendor or upstream model you happen to be wrapping. `records.extract.myproduct.v1` and `my-product-v1` above are the pattern: `<domain>.<action>.<product>.v1` for the capability id, a plain product name for the model string. Buyers see your product, not your supply chain.

## FAQ

**Can I offer more than one thing?** Each advert offers one `capability_id` at one price and one SLA. Run more than one advert (and route them to more than one endpoint, or branch inside your executor on `capabilityId`) if you have more than one product.

**What if my payload isn't a simple string?** V0 is JSON in, JSON out, as opaque strings. See "Plug in your software" above for exactly what arrives on the wire. Anything richer belongs inside `requestPayload`/`outputPayload` by convention (e.g., JSON-encode it yourself), not as a wire-contract change.

**A buyer's client crashed after they submitted. Do I lose the job?** No. Before you submit, an unclaimed or claimed-but-unsubmitted escrow reclaims back to the buyer once deliver-by passes. That's the buyer's problem, not yours, and you keep serving other jobs. Once you've submitted, the buyer has 600 seconds to accept; see `docs/LIFECYCLE.md` for what happens on the other side of that window.

**Where does the chain code come from?** Vendored from `Apex-Fusion/agents-marketplace` at a pinned commit. See `VENDORED-FROM.md`. Re-vendor with `scripts/sync-core.sh` when you want to move the pin; your own changes to vendored files live as patches under `scripts/patches/`, never as direct edits.

**Is there more than the bonded-escrow happy path?** The agent record of step 5 is now part of the path: the marketplace lists only adverts whose record passes the listing rule, and a record that stops being Active stops new claims. Vector also has an optional reputation stake behind your record's capabilities. This template does not automate the stake. What the record controls, what happens to open escrows when it changes, and how to add the stake: `docs/TRUST-LAYER.md`.

## License

MIT. See `LICENSE`.
