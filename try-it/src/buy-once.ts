/**
 * try-it/src/buy-once.ts — one command, one real purchase, one verified receipt.
 *
 *   corepack pnpm --filter try-it exec tsx src/buy-once.ts \
 *     --advert-ref <txHash#ix> --endpoint http://host:8080 --payload-file ./payload.txt
 *
 * Posts a bonded escrow against the agent's advert, hands the agent the job,
 * polls until it is done, verifies the signed receipt OFFLINE, and only then
 * Accepts (which releases payment). Exit 0 means: settled on chain and the
 * receipt verified. Anything else exits non-zero with one line on stderr.
 *
 * ─── ESCROW BUILDER CHOICE (read this before changing the payload shape) ───
 *
 * Builder: `buildPostEscrowTx` (the generic `packages/shared/src/tx/escrow/postEscrow.ts`).
 *
 * Why: the custom capability's wire contract is `escrow.prompt_hash ===
 * sha256(utf8(payload))` over the RAW payload string (agent/src/routes/custom.ts),
 * and NO vendored builder accepts a precomputed prompt_hash - each computes its
 * own: postEscrow hashes `canonicalize(messages)`, postChatEscrow hashes a
 * session-nonce envelope, postOcrEscrow/postTtsEscrow hash their own request
 * envelopes. So the buyer cannot choose the hash; it can only choose the
 * PREIMAGE. This harness therefore puts that preimage on the wire verbatim:
 * the payload string it POSTs IS `canonicalize([{content: <your file>, role: "user"}])`,
 * the exact bytes postEscrow hashed. Contract satisfied with zero
 * re-implementation, and the agent still does no canonicalisation of its own.
 *
 * Consequence, stated plainly: with the vendored builders, a buyer's payload is
 * that one-element canonical chat envelope, not arbitrary bytes. The AGENT side
 * is fully general - any buyer able to commit an arbitrary prompt_hash may send
 * any string - so lifting this means an upstream builder that takes a
 * precomputed prompt_hash, not a change here. Step 4 below re-reads the posted
 * datum and aborts BEFORE the agent is called if the two hashes ever diverge,
 * so builder drift surfaces as one clear line instead of a 409 per purchase.
 *
 * ─── Order of operations ───
 * Verification happens BEFORE Accept, not after (the brief's flow verified
 * after). Both hash checks plus the ed25519 check cost microseconds, so the
 * 600 s Accept window is in no danger, and accepting an unverifiable receipt is
 * exactly the thing a bonded escrow exists to prevent: an unaccepted escrow is
 * still the buyer's to reclaim after deliver_by.
 *
 * Env: BUYER_PRIV_KEY_HEX, OGMIOS_URL, NETWORK_ID, VECTOR_ZERO_TIME_MS (all required).
 * VECTOR_ZERO_TIME_MS is required rather than defaulted on purpose: the vendored
 * slot maths falls back to a testnet genesis when it is unset, which produces
 * confident, wrong validity ranges (PastHorizon) instead of an error.
 */

import { readFileSync } from "fs";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";

import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { OutputReference } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { EscrowDatum } from "@marketplace/shared/cbor";
import { buildPostEscrowTx, buildAcceptTx } from "@marketplace/shared/tx";
import type { ChatMessage, WalletKey } from "@marketplace/shared/tx";

import { verifyReceipt } from "./verify-receipt.js";

// @noble/ed25519 v2 sync API needs a sha512 hook installed at load time.
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const REF_RE = /^([0-9a-fA-F]{64})#(0|[1-9]\d*)$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/** Chain-confirmation budget for PostEscrow / Accept. */
const DEFAULT_AWAIT_TIMEOUT_MS = 180_000;
/** Poll cadence for GET /v1/job/:jobId. */
const DEFAULT_POLL_INTERVAL_MS = 3_000;
/** Client budget for POST /v1/job — it blocks on the agent's Claim confirmation. */
const JOB_SUBMIT_TIMEOUT_MS = 180_000;
/** Extra head-room over the advert SLA before we give up polling. */
const JOB_TIMEOUT_SLACK_MS = 120_000;
/** How long to look for the Submitted-state escrow UTxO after the job is done. */
const SUBMITTED_LOOKUP_TIMEOUT_MS = 90_000;

export interface CliArgs {
  advertRef: OutputReference;
  endpoint: string;
  payloadFile: string;
  pollIntervalMs: number;
  awaitTimeoutMs: number;
  /** 0 = derive from the advert's max_processing_ms. */
  jobTimeoutMs: number;
}

export interface EnvConfig {
  privKeyHex: string;
  ogmiosUrl: string;
  networkId: 0 | 1;
  zeroTimeMs: number;
}

/** Thrown for every expected failure; `reason` is the machine-readable code. */
class BuyError extends Error {
  public readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "BuyError";
    this.reason = reason;
  }
}

// ─── args + env ────────────────────────────────────────────────────────────

function parseRef(raw: string, flag: string): OutputReference {
  const m = REF_RE.exec(raw);
  if (!m) throw new BuyError("bad_args", `${flag} must be <64-hex-txhash>#<index> (got: ${raw})`);
  return { txHash: m[1].toLowerCase(), index: Number(m[2]) };
}

function parsePositiveInt(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new BuyError("bad_args", `${flag} must be a non-negative integer (got: ${raw})`);
  return Number(raw);
}

export function parseArgs(argv: string[]): CliArgs {
  let advertRef: OutputReference | null = null;
  let endpoint = "";
  let payloadFile = "";
  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  let awaitTimeoutMs = DEFAULT_AWAIT_TIMEOUT_MS;
  let jobTimeoutMs = 0;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const val = argv[i + 1];
    const need = (): string => {
      if (val === undefined) throw new BuyError("bad_args", `${tok} requires a value`);
      i++;
      return val;
    };
    switch (tok) {
      case "--advert-ref": advertRef = parseRef(need(), "--advert-ref"); break;
      case "--endpoint": endpoint = need().replace(/\/+$/, ""); break;
      case "--payload-file": payloadFile = need(); break;
      case "--poll-interval-ms": pollIntervalMs = parsePositiveInt(need(), "--poll-interval-ms"); break;
      case "--await-timeout-ms": awaitTimeoutMs = parsePositiveInt(need(), "--await-timeout-ms"); break;
      case "--job-timeout-ms": jobTimeoutMs = parsePositiveInt(need(), "--job-timeout-ms"); break;
      default: throw new BuyError("bad_args", `unknown flag: ${tok}`);
    }
  }

  if (!advertRef) throw new BuyError("bad_args", "--advert-ref is required");
  if (!endpoint) throw new BuyError("bad_args", "--endpoint is required");
  if (!payloadFile) throw new BuyError("bad_args", "--payload-file is required");
  if (!/^https?:\/\//.test(endpoint)) {
    throw new BuyError("bad_args", `--endpoint must be an http(s) URL (got: ${endpoint})`);
  }
  return { advertRef, endpoint, payloadFile, pollIntervalMs, awaitTimeoutMs, jobTimeoutMs };
}

export function loadEnvConfig(env: Record<string, string | undefined>): EnvConfig {
  const privKeyHex = env.BUYER_PRIV_KEY_HEX ?? "";
  if (!HEX64_RE.test(privKeyHex)) {
    throw new BuyError("bad_env", "BUYER_PRIV_KEY_HEX must be a 32-byte (64-char) hex string");
  }
  const ogmiosUrl = env.OGMIOS_URL ?? "";
  if (!ogmiosUrl) throw new BuyError("bad_env", "OGMIOS_URL is required");
  if (env.NETWORK_ID !== "0" && env.NETWORK_ID !== "1") {
    throw new BuyError("bad_env", `NETWORK_ID must be "0" or "1" (got: ${env.NETWORK_ID ?? "unset"})`);
  }
  const zeroTimeMs = Number(env.VECTOR_ZERO_TIME_MS);
  if (!Number.isFinite(zeroTimeMs) || zeroTimeMs <= 0) {
    throw new BuyError(
      "bad_env",
      "VECTOR_ZERO_TIME_MS is required (network genesis, ms). Unset, the tx builders fall back to a testnet genesis and emit wrong validity ranges",
    );
  }
  return { privKeyHex, ogmiosUrl, networkId: env.NETWORK_ID === "1" ? 1 : 0, zeroTimeMs };
}

// ─── wallet ────────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

/** Same derivation the agent's CLIs use (agent/src/cli/post-advert.ts). */
export function deriveWalletKey(privHex: string, networkId: 0 | 1): WalletKey {
  const pub = ed.getPublicKey(hexToBytes(privHex));
  const pkh = blake2b(pub, { dkLen: 28 });
  const payload = new Uint8Array(29);
  payload[0] = networkId === 0 ? 0x60 : 0x61;
  payload.set(pkh, 1);
  return {
    pubKeyHash: bytesToHex(pkh),
    pubKeyHex: bytesToHex(pub),
    privateKeyHex: privHex,
    address: bech32.encode(networkId === 0 ? "addr_test" : "addr", bech32.toWords(payload), 1023),
  };
}

// ─── small helpers ─────────────────────────────────────────────────────────

function sha256Utf8Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface WirePayload {
  /** What postEscrow hashes into the escrow datum. */
  messages: ChatMessage[];
  /** The exact string POSTed as `payload` — byte-identical to what was hashed. */
  wirePayload: string;
  /** sha256(utf8(wirePayload)) === escrow.prompt_hash === the agent's recomputation. */
  promptHash: string;
}

/**
 * The whole buyer half of the wire contract, in one place: the payload string
 * put on the wire IS `canonicalize(messages)`, the preimage `buildPostEscrowTx`
 * hashes. See the builder-choice note in the file header for why the buyer
 * chooses the preimage rather than the hash. Pinned by buy-once.wire.test.ts.
 */
export function buildWirePayload(payloadText: string): WirePayload {
  const messages: ChatMessage[] = [{ role: "user", content: payloadText }];
  const wirePayload = canonicalize(messages);
  return { messages, wirePayload, promptHash: sha256Utf8Hex(wirePayload) };
}

function refStr(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Tag whatever a chain call throws with the step that threw it, so every
 * failure prints one line that says what to go look at. `TxConstructionError`
 * already carries a machine-readable `reason`; it is folded into the detail
 * rather than discarded.
 */
async function chainStep<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof BuyError) throw err;
    const e = err as { reason?: string; message?: string };
    const inner = typeof e.reason === "string" ? `${e.reason}: ` : "";
    throw new BuyError(reason, `${inner}${e.message ?? String(err)}`);
  }
}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

async function httpJson(url: string, init: RequestInit, timeoutMs = 30_000): Promise<HttpResult> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new BuyError("agent_unreachable", `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

function errDetail(body: unknown, fallback: string): string {
  if (body && typeof body === "object") {
    const o = body as Record<string, unknown>;
    const reason = typeof o.reason === "string" ? o.reason : "";
    const message = typeof o.message === "string" ? o.message : "";
    if (reason || message) return `${reason}${reason && message ? ": " : ""}${message}`;
  }
  return fallback;
}

// ─── the settled escrow moves; find where it went ──────────────────────────

/**
 * Claim and Submit each SPEND the escrow UTxO and re-create it at a new tx
 * hash, so the ref this buyer posted is stale by the time the job is done, and
 * `buildAcceptTx` needs the current Submitted-state one. Upstream's buyer finds
 * it through the marketplace indexer (`/escrows?buyer=`); this template ships no
 * indexer, so we scan the escrow script address on Ogmios and match the datum
 * against our own commitment: buyer key + prompt hash + the `posted_at` we read
 * off our own escrow. The state machine carries all three through Claim and
 * Submit unchanged, and `posted_at` is what keeps a second run of the same
 * payload file from being mistaken for this one.
 */
async function resolveSubmittedEscrow(opts: {
  chain: LiveOgmiosProvider;
  escrowAddress: string;
  buyerPkh: string;
  promptHash: string;
  postedAt: number;
  timeoutMs: number;
  intervalMs: number;
}): Promise<{ ref: OutputReference; datum: EscrowDatum }> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const utxos = await opts.chain.queryUtxosByAddress(opts.escrowAddress);
    const matches: Array<{ ref: OutputReference; datum: EscrowDatum }> = [];
    for (const u of utxos) {
      if (!u.datumHex) continue;
      let datum: EscrowDatum;
      try {
        datum = decodeEscrowDatum(u.datumHex);
      } catch {
        continue; // not an escrow datum we understand — someone else's UTxO
      }
      if (
        datum.state === "Submitted" &&
        datum.buyer_pkh === opts.buyerPkh &&
        datum.prompt_hash === opts.promptHash &&
        datum.posted_at === opts.postedAt
      ) {
        matches.push({ ref: u.ref, datum });
      }
    }
    if (matches.length > 0) {
      matches.sort((a, b) => (b.datum.submitted_at ?? 0) - (a.datum.submitted_at ?? 0));
      return matches[0];
    }
    if (Date.now() >= deadline) {
      throw new BuyError(
        "submitted_escrow_not_found",
        `no Submitted escrow with prompt_hash=${opts.promptHash} at ${opts.escrowAddress} within ${opts.timeoutMs}ms`,
      );
    }
    await sleep(opts.intervalMs);
  }
}

// ─── job poll ──────────────────────────────────────────────────────────────

interface DoneJob {
  output: string;
  receipt: unknown;
  signature: unknown;
}

async function pollJob(opts: {
  endpoint: string;
  jobId: string;
  intervalMs: number;
  timeoutMs: number;
}): Promise<DoneJob> {
  const url = `${opts.endpoint}/v1/job/${opts.jobId}`;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const res = await httpJson(url, { method: "GET" });
    if (res.status === 200) {
      const body = (res.body ?? {}) as Record<string, unknown>;
      const choices = Array.isArray(body.choices) ? body.choices : [];
      const first = (choices[0] ?? {}) as Record<string, unknown>;
      const message = (first.message ?? {}) as Record<string, unknown>;
      if (typeof message.content !== "string") {
        throw new BuyError("job_response_malformed", "done job carried no choices[0].message.content string");
      }
      return { output: message.content, receipt: body.receipt, signature: body.receipt_signature };
    }
    if (res.status !== 202) {
      throw new BuyError("job_failed", errDetail(res.body, `GET /v1/job returned HTTP ${res.status}: ${res.text.slice(0, 200)}`));
    }
    if (Date.now() >= deadline) {
      throw new BuyError("job_timeout", `job ${opts.jobId} still running after ${opts.timeoutMs}ms`);
    }
    await sleep(opts.intervalMs);
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  let args: CliArgs;
  let cfg: EnvConfig;
  try {
    args = parseArgs(argv);
    cfg = loadEnvConfig(env);
  } catch (err) {
    const e = err as BuyError;
    process.stderr.write(`error: ${e.reason ?? "bad_args"}: ${e.message}\n`);
    return 1;
  }

  // The vendored slot maths reads VECTOR_ZERO_TIME_MS off process.env at build
  // time; make sure the value we validated is the one it sees.
  process.env.VECTOR_ZERO_TIME_MS = String(cfg.zeroTimeMs);

  try {
    // ── 1. Payload -> the exact bytes both sides commit to ────────────────
    let payloadText: string;
    try {
      payloadText = readFileSync(args.payloadFile, "utf8");
    } catch (err) {
      throw new BuyError("payload_unreadable", `${args.payloadFile}: ${(err as Error).message}`);
    }
    if (payloadText.length === 0) {
      throw new BuyError("payload_empty", `${args.payloadFile} is empty`);
    }
    // See the builder-choice note in the file header: the wire payload IS the
    // preimage postEscrow hashes, so sha256(wirePayload) === escrow.prompt_hash.
    const { messages, wirePayload, promptHash } = buildWirePayload(payloadText);

    const buyerKey = deriveWalletKey(cfg.privKeyHex, cfg.networkId);
    const chain = new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });
    log(`buyer     ${buyerKey.address}`);
    log(`advert    ${refStr(args.advertRef)}`);
    log(`prompt    sha256=${promptHash} (${wirePayload.length} bytes on the wire)`);

    // ── 2. Read the advert (price, SLA, capability) ───────────────────────
    const advertUtxo = await chainStep("advert_query_failed", () => chain.queryUtxo(args.advertRef));
    if (advertUtxo === null || !advertUtxo.datumHex) {
      throw new BuyError("advert_not_found", `no advert UTxO with an inline datum at ${refStr(args.advertRef)}`);
    }
    const advert = decodeAdvertDatum(advertUtxo.datumHex);
    if (advert.status !== "Active") {
      throw new BuyError("advert_not_active", `advert status is ${advert.status}`);
    }
    const totalLovelace = advert.price_lovelace + advert.buyer_bond_lovelace + advert.supplier_bond_lovelace;
    log(`capability ${advert.capability_id} model=${advert.model}`);
    log(`price     ${advert.price_lovelace} lovelace (+bonds -> ${totalLovelace} locked), sla=${advert.max_processing_ms}ms`);

    // ── 3. Post the escrow ────────────────────────────────────────────────
    log("post-escrow: building + submitting...");
    const posted = await chainStep("escrow_post_failed", () => buildPostEscrowTx({
      chain,
      buyerKey,
      advertRef: args.advertRef,
      messages,
      payment_lovelace: advert.price_lovelace,
    }));
    log(`post-escrow: submitted ${posted.expectedTxHash}, awaiting confirmation`);
    await chainStep("escrow_confirm_failed", () => chain.awaitTx(posted.expectedTxHash, args.awaitTimeoutMs));
    const escrowRef = posted.escrowOutputRef;
    log(`escrow    ${refStr(escrowRef)} confirmed`);

    // ── 4. Wire-contract self-check, BEFORE the agent is involved ─────────
    const escrowUtxo = await chainStep("escrow_query_failed", () => chain.queryUtxo(escrowRef));
    if (escrowUtxo === null || !escrowUtxo.datumHex) {
      throw new BuyError("escrow_not_found", `escrow UTxO ${refStr(escrowRef)} vanished after confirmation`);
    }
    const escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
    if (escrowDatum.prompt_hash !== promptHash) {
      throw new BuyError(
        "prompt_hash_contract_broken",
        `escrow commits ${escrowDatum.prompt_hash} but the payload on the wire hashes to ${promptHash} — the escrow builder no longer hashes the bytes we send; see the builder-choice note in buy-once.ts`,
      );
    }
    const escrowAddress = escrowUtxo.address;

    // ── 5. Hand the job to the agent ──────────────────────────────────────
    // POST /v1/job does NOT return until the agent has built AND confirmed its
    // Claim tx (a 60 s awaitTx inside the route), so the client budget has to
    // cover a chain round-trip. Time out early and the agent still claims the
    // escrow while this process has no job_id to poll.
    const submitRes = await httpJson(`${args.endpoint}/v1/job`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ escrow_ref: refStr(escrowRef), payload: wirePayload }),
    }, JOB_SUBMIT_TIMEOUT_MS);
    if (submitRes.status !== 202) {
      throw new BuyError("job_rejected", errDetail(submitRes.body, `POST /v1/job returned HTTP ${submitRes.status}: ${submitRes.text.slice(0, 200)}`));
    }
    const jobId = (submitRes.body as Record<string, unknown> | null)?.job_id;
    if (typeof jobId !== "string" || jobId.length === 0) {
      throw new BuyError("job_rejected", "POST /v1/job returned 202 without a job_id");
    }
    log(`job       ${jobId} accepted, polling every ${args.pollIntervalMs}ms`);

    // ── 6. Poll to a terminal state ───────────────────────────────────────
    const jobTimeoutMs = args.jobTimeoutMs > 0 ? args.jobTimeoutMs : advert.max_processing_ms + JOB_TIMEOUT_SLACK_MS;
    const done = await pollJob({
      endpoint: args.endpoint,
      jobId,
      intervalMs: args.pollIntervalMs,
      timeoutMs: jobTimeoutMs,
    });
    log(`job       done, ${done.output.length} bytes of output`);

    // ── 7. Verify the receipt offline, BEFORE paying ──────────────────────
    const capRes = await httpJson(`${args.endpoint}/capability`, { method: "GET" });
    if (capRes.status !== 200) {
      throw new BuyError("capability_unavailable", errDetail(capRes.body, `GET /capability returned HTTP ${capRes.status}`));
    }
    const pubKeyHex = (capRes.body as Record<string, unknown> | null)?.pub_key_hex;
    if (typeof pubKeyHex !== "string") {
      throw new BuyError("capability_unavailable", "GET /capability returned no pub_key_hex");
    }
    const verdict = verifyReceipt(
      { receipt: done.receipt, signature: done.signature },
      wirePayload,
      done.output,
      pubKeyHex,
    );
    if (!verdict.ok) {
      throw new BuyError(
        "receipt_unverified",
        `${verdict.reason} — NOT accepting; the escrow stays locked and is reclaimable after deliver_by`,
      );
    }
    log("receipt   verified offline (prompt hash, response hash, supplier signature)");

    // ── 8. Accept: releases payment, closes the escrow ────────────────────
    const submitted = await chainStep("submitted_lookup_failed", () => resolveSubmittedEscrow({
      chain,
      escrowAddress,
      buyerPkh: buyerKey.pubKeyHash,
      promptHash,
      postedAt: escrowDatum.posted_at,
      timeoutMs: SUBMITTED_LOOKUP_TIMEOUT_MS,
      intervalMs: args.pollIntervalMs,
    }));
    log(`accept    spending ${refStr(submitted.ref)} (submitted_at=${submitted.datum.submitted_at})`);
    const accepted = await chainStep("accept_failed", () => buildAcceptTx({ chain, buyerKey, escrowRef: submitted.ref }));
    await chainStep("accept_confirm_failed", () => chain.awaitTx(accepted.expectedTxHash, args.awaitTimeoutMs));

    process.stdout.write(`${JSON.stringify({
      escrow_ref: refStr(escrowRef),
      submitted_escrow_ref: refStr(submitted.ref),
      job_id: jobId,
      accept_tx: accepted.expectedTxHash,
      verified: true,
    })}\n`);
    return 0;
  } catch (err) {
    if (err instanceof BuyError) {
      process.stderr.write(`error: ${err.reason}: ${err.message}\n`);
      return 1;
    }
    // TxConstructionError carries its own machine-readable reason; everything
    // else degrades to the class name so the line still parses.
    const e = err as { reason?: string; name?: string; message?: string };
    const reason = typeof e.reason === "string" ? e.reason : (e.name ?? "error");
    process.stderr.write(`error: ${reason}: ${e.message ?? String(err)}\n`);
    return 1;
  }
}

// Auto-invoke when run directly (tsx src/buy-once.ts).
if (process.argv[1]?.endsWith("buy-once.ts") || process.argv[1]?.endsWith("buy-once.js")) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`buy-once: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
