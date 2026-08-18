/**
 * agent/src/routes/custom.ts — POST /v1/job + GET /v1/job/:jobId.
 *
 * Structural fork of `makeChatHandler` / `makeGetJobHandler` (../server.ts):
 * same lifecycle (validate → resolve advert → resolve escrow → state/identity/
 * capability checks → hash checks → deadline → acquire slot → Claim tx →
 * fire-and-forget runner → 202), same error envelope, same slot-release
 * discipline. Substitutions, and only these:
 *
 *   - request body is `{ escrow_ref, payload }` (the chat route takes the ref
 *     from an X-Escrow-Ref header and a `messages` array in the body);
 *   - prompt_hash check is sha256(utf8(payload)) — the raw request bytes, not
 *     a canonicalised message array;
 *   - the runner is `runCustomJob`, handed the mounted Executor.
 *
 * The private helpers `makeChatHandler` leans on (jsonError, parseEscrowRef,
 * sha256Hex, fetchActiveAdvert, the two regexes) are module-private in
 * server.ts and are copied here verbatim rather than exported from the
 * vendored file — server.ts only takes the mount branch + its imports.
 */

import type { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { decodeAdvertDatum, decodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import {
  buildClaimTx,
  mockSlotToWallclockMs,
  detectCborBackend,
} from "@marketplace/shared/tx";

import type { SupplierState } from "../state.js";
import type { SupplierConfig } from "../config.js";
import type { JobStore } from "../jobs.js";
import type { Executor } from "../executor/executor.js";
import { runCustomJob } from "../customJobRunner.js";
import { triggerOnFailureConsolidate } from "../walletHealth.js";

/**
 * The subset of server.ts's (module-private) ResolvedDeps these handlers use,
 * plus the Executor the `custom` mount branch attaches. Structurally satisfied
 * by ResolvedDeps, so `makeCustomHandler(resolved)` type-checks at the mount.
 */
export interface CustomRouteDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  jobs: JobStore;
  /** Attached by createApp for capabilityKind="custom". */
  executor?: Executor;
}

const ESCROW_REF_RE = /^[0-9a-fA-F]{64}#(?:0|[1-9]\d*)$/;
const UUID_V4_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function parseEscrowRef(ref: string): OutputReference | null {
  if (!ESCROW_REF_RE.test(ref)) return null;
  const idx = ref.indexOf("#");
  return { txHash: ref.slice(0, idx), index: Number(ref.slice(idx + 1)) };
}

function jsonError(res: Response, status: number, reason: string, message: string): Response {
  return res
    .status(status)
    .json({ reason, message, error: { reason, message } });
}

interface CustomBody {
  escrow_ref?: unknown;
  payload?: unknown;
}

type AdvertResult =
  | { datum: AdvertDatum }
  | { error: { status: number; reason: string; message: string } };

async function fetchActiveAdvert(deps: CustomRouteDeps): Promise<AdvertResult> {
  const utxo = await deps.chain.queryUtxo(deps.config.advertRef);
  if (utxo === null || !utxo.datumHex) {
    return { error: { status: 503, reason: "advert_unavailable", message: "advert UTxO missing on chain" } };
  }
  let datum: AdvertDatum;
  try {
    datum = decodeAdvertDatum(utxo.datumHex);
  } catch (err) {
    return { error: { status: 503, reason: "advert_decode_failed", message: (err as Error).message } };
  }
  if (datum.status !== "Active") {
    return { error: { status: 503, reason: "advert_not_active", message: `advert status=${datum.status}` } };
  }
  return { datum };
}

// ─── POST /v1/job ──────────────────────────────────────────────────────────

export function makeCustomHandler(deps: CustomRouteDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Slot held by THIS request (null until acquired / after hand-off to the
    // job runner) — the catch-all must only release its own acquisition.
    let acquiredRef: string | null = null;
    try {
      // ── 1+2. Body shape validation ────────────────────────────────────
      const body = (req.body ?? {}) as CustomBody;
      const escrowRefRaw = typeof body.escrow_ref === "string" ? body.escrow_ref : "";
      if (escrowRefRaw.length === 0) {
        return jsonError(res, 400, "escrow_ref_required", "escrow_ref is required");
      }
      const escrowRef = parseEscrowRef(escrowRefRaw);
      if (escrowRef === null) {
        return jsonError(res, 400, "escrow_ref_malformed",
          'escrow_ref must match "<64-hex>#<int>"');
      }
      const escrowRefStr = `${escrowRef.txHash}#${escrowRef.index}`;
      if (typeof body.payload !== "string" || body.payload.length === 0) {
        return jsonError(res, 400, "payload_required", "payload must be a non-empty string");
      }
      const payload = body.payload;

      // ── 3. Resolve advert ────────────────────────────────────────────
      const advertResult = await fetchActiveAdvert(deps);
      if ("error" in advertResult) {
        const e = advertResult.error;
        return jsonError(res, e.status, e.reason, e.message);
      }
      const advert = advertResult.datum;

      // ── 4. Resolve escrow UTxO ───────────────────────────────────────
      const escrowUtxo = await deps.chain.queryUtxo(escrowRef);
      if (escrowUtxo === null || !escrowUtxo.datumHex) {
        return jsonError(res, 404, "escrow_not_found",
          `escrow UTxO ${escrowRefStr} not found on chain`);
      }
      let escrowDatum: EscrowDatum;
      try {
        escrowDatum = decodeEscrowDatum(escrowUtxo.datumHex);
      } catch (err) {
        return jsonError(res, 404, "escrow_decode_failed", (err as Error).message);
      }

      // ── 5. State / identity / capability ─────────────────────────────
      if (escrowDatum.state !== "Open") {
        return jsonError(res, 409, "escrow_not_claimable",
          `escrow state is ${escrowDatum.state}, expected Open`);
      }
      if (escrowDatum.supplier_pkh !== deps.supplierKey.pubKeyHash) {
        return jsonError(res, 403, "wrong_supplier",
          "escrow supplier_pkh does not match this node");
      }
      if (escrowDatum.capability_id !== advert.capability_id) {
        return jsonError(res, 409, "capability_mismatch",
          `escrow capability ${escrowDatum.capability_id} != advert ${advert.capability_id}`);
      }

      // ── 6. Hash checks ───────────────────────────────────────────────
      const expectedRequestSpecHash = sha256Hex(canonicalize({
        capability_id: advert.capability_id,
        max_output_tokens: advert.max_output_tokens,
        model: advert.model,
      }));
      if (escrowDatum.request_spec_hash !== expectedRequestSpecHash) {
        return jsonError(res, 409, "request_spec_mismatch",
          "request_spec_hash in escrow does not match advert spec");
      }
      // The custom prompt commitment is the raw request bytes — sha256 over
      // the payload string, no canonicalisation. The buyer commits the same.
      const expectedPromptHash = sha256Hex(payload);
      if (escrowDatum.prompt_hash !== expectedPromptHash) {
        return jsonError(res, 409, "prompt_mismatch",
          "prompt_hash in escrow does not match request body payload");
      }

      // ── 7. Deadline ──────────────────────────────────────────────────
      const tipSlot = await deps.chain.tip();
      const isLive = detectCborBackend(deps.chain) === "live";
      const nowMs = isLive
        ? Date.now()
        : Math.max(mockSlotToWallclockMs(tipSlot), escrowDatum.posted_at);
      if (nowMs >= escrowDatum.deliver_by) {
        return jsonError(res, 408, "past_deliver_by",
          `now ${nowMs} >= deliver_by ${escrowDatum.deliver_by}`);
      }

      // ── 8. Acquire session slot ──────────────────────────────────────
      if (!deps.state.tryAcquire(escrowRefStr)) {
        return jsonError(res, 409, "supplier_busy", "supplier is already working another job");
      }
      acquiredRef = escrowRefStr;
      // From here on, every error path MUST release the slot until the
      // runner takes ownership of it.

      // ── 9+10. Claim tx: build + confirm as ONE wallet critical section ─
      // (splitting them would let another wallet spend coin-select mid-flight)
      const claimOutcome = await deps.state.walletMutex.run(async () => {
        let built;
        try {
          built = await buildClaimTx({
            chain: deps.chain,
            supplierKey: deps.supplierKey,
            escrowRef,
          });
        } catch (err) {
          return { kind: "build_failed" as const, err };
        }
        try {
          await deps.chain.awaitTx(built.expectedTxHash, 60_000);
        } catch (err) {
          return { kind: "await_failed" as const, err };
        }
        return { kind: "ok" as const, built };
      });
      if (claimOutcome.kind === "build_failed") {
        deps.state.release(escrowRefStr);
        acquiredRef = null;
        // Backstop the periodic wallet-health ticker: most Claim build failures
        // we see in practice are wallet-shape problems (fragmentation, dust).
        // Fire-and-forget a debounced consolidate so the NEXT buyer retry
        // finds a clean 2-UTxO wallet. Safe no-op if already healthy.
        triggerOnFailureConsolidate({
          chain: deps.chain,
          state: deps.state,
          supplierKey: deps.supplierKey,
        });
        return jsonError(res, 503, "chain_submit_failed",
          `Claim tx submit failed: ${(claimOutcome.err as Error).message}`);
      }
      if (claimOutcome.kind === "await_failed") {
        deps.state.release(escrowRefStr);
        acquiredRef = null;
        return jsonError(res, 504, "claim_timeout",
          `Claim awaitTx failed: ${(claimOutcome.err as Error).message}`);
      }
      const claimResult = claimOutcome.built;

      // ── 11. Continuing-output ref + create job + fire-and-forget ─────
      const claimedRef: OutputReference = {
        txHash: claimResult.expectedTxHash,
        index: 0,
      };
      const jobId = deps.jobs.create(escrowRefStr);

      // Slot release now happens inside runCustomJob's finally.
      acquiredRef = null;
      void runCustomJob({
        deps: {
          chain: deps.chain,
          state: deps.state,
          config: deps.config,
          supplierKey: deps.supplierKey,
          jobs: deps.jobs,
        },
        executor: deps.executor as Executor,
        jobId,
        escrowRef: escrowRefStr,
        claimedRef,
        advert,
        escrowDatum,
        requestBody: { payload },
      });

      // ── 12. 202 Accepted ─────────────────────────────────────────────
      return res.status(202).json({
        job_id: jobId,
        status: "accepted",
        escrow_ref: escrowRefStr,
      });
    } catch (err) {
      if (acquiredRef) {
        try { deps.state.release(acquiredRef); } catch { /* ignore */ }
      }
      next(err);
      return;
    }
  };
}

// ─── GET /v1/job/:jobId ────────────────────────────────────────────────────

export function makeGetCustomJobHandler(deps: CustomRouteDeps) {
  return (req: Request, res: Response) => {
    const rawJobId = req.params.jobId;
    const jobId = typeof rawJobId === "string" ? rawJobId : "";
    if (!UUID_V4_RE.test(jobId)) {
      return jsonError(res, 400, "invalid_job_id",
        "jobId must be a UUIDv4 string");
    }
    const record = deps.jobs.get(jobId);
    if (!record) {
      return jsonError(res, 404, "job_not_found",
        `no job found with id ${jobId}`);
    }
    res.setHeader("Content-Type", "application/json");
    if (record.status === "accepted" || record.status === "running") {
      return res.status(202).json({
        status: record.status,
        escrow_ref: record.escrowRef,
      });
    }
    if (record.status === "done") {
      const payload = record.responsePayload!;
      // Defensive narrowing: this poll route only knows how to render the
      // chat shape. A future shared JobStore could mix capabilities; we'd
      // want each kind's poll to be sure it's reading its own.
      if (payload.kind === "ocr" || "audio_b64" in payload) {
        return jsonError(res, 500, "wrong_payload_kind",
          "non-chat payload returned to chat poll route");
      }
      return res.status(200).json({
        choices: payload.choices,
        usage: payload.usage,
        receipt: payload.receipt,
        receipt_signature: payload.receipt_signature,
        escrow_ref: record.escrowRef,
      });
    }
    // failed
    const f = record.failure!;
    return res.status(f.httpStatus).json({
      status: "failed",
      reason: f.reason,
      message: f.message,
      escrow_ref: record.escrowRef,
    });
  };
}
