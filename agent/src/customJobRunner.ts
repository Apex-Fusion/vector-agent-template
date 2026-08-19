/**
 * agent/src/customJobRunner.ts — Background job runner for the `custom` capability.
 *
 * Structural fork of `runChatJob` (./jobRunner.ts): same 7-step shape, same
 * failure-code table, same lock semantics, same receipt/Submit scaffolding.
 *   1. jobs.setRunning(jobId)                    [BEFORE the executor call]
 *   2. executor.execute(...)                     [on rejection: jobs.fail(reason)]
 *   3. build + sign receipt
 *   4. construct + submit Submit tx via buildSubmitTx()
 *      [on rejection: jobs.fail("submit_failed")]
 *   5. await Submit tx confirmation (60s budget)
 *      [on rejection: jobs.fail("submit_timeout")]
 *   6. jobs.complete(jobId, payload)
 *   7. release supplier lock                     [ALWAYS, in try/finally]
 *
 * The only difference from runChatJob is step 2: instead of Ollama/OpenAI, one
 * `Executor.execute` call against the operator's black box (the template's
 * single integration seam). Everything else is the proven money path.
 *
 * Step 2's deadline is min(SERVICE_TIMEOUT_MS, deliver_by - now - SUBMIT_RESERVE_MS):
 * a job claimed late in its window gets a correspondingly smaller executor
 * budget, so it cannot burn the full configured timeout and then miss the
 * on-chain deliver_by deadline on Submit. When that leaves nothing, the job
 * fails as `deliver_by_too_close` without calling the operator's service at
 * all: work that cannot be submitted in time is work nobody gets paid for.
 *
 * The function NEVER throws — all errors are captured into jobs.fail.
 *
 * Wire contract (the buyer must compute the same two hashes):
 *   prompt_hash   = sha256(utf8(payload))         — committed in the escrow datum
 *   response_hash = sha256(utf8(outputPayload))   — no canonicalisation, no wrapping
 *
 * Terminal payload stays `ChatJobResponsePayload` so the vendored poll-route
 * rendering works unchanged; its `content` field carries `outputPayload`.
 */

import type { OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { createHash } from "crypto";

import type { RunChatJobDeps } from "./jobRunner.js";
import type { ChatJobResponsePayload } from "./jobs.js";
import type { Executor } from "./executor/executor.js";
import { ExecutorError } from "./executor/executor.js";

export interface RunCustomJobParams {
  deps: RunChatJobDeps;            // reuse the vendored deps type unchanged
  executor: Executor;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  requestBody: { payload: string };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Time held back, after the executor returns, for step 4+5: build the Submit
 * transaction, submit it, and wait for it to land, all before the escrow's
 * on-chain deliver_by. Submit is a script spend, so this is a chain round trip,
 * not a function call. A job that lets the executor run right up to deliver_by
 * produces a result it can never submit, and forfeits the supplier bond on
 * work it actually did. Mirrors the 30 s the boot guard reserves in
 * server.ts's SLA arithmetic.
 */
const SUBMIT_RESERVE_MS = 30_000;

/**
 * Run the operator's service → receipt → Submit in the background.
 * Always resolves (never rejects). Terminal state written to jobs store.
 * Supplier lock is released in try/finally regardless of outcome.
 */
export async function runCustomJob(params: RunCustomJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  // ── 1. Mark job running BEFORE the executor call (ordering pin) ──────
  deps.jobs.setRunning(jobId);

  try {
    // ── 2. Call the operator's service through the Executor seam ───────
    // Same { content, prompt_tokens, completion_tokens, wallclock_ms } shape
    // the LLM backends return, so receipt construction downstream is
    // identical. A black box has no token semantics — both counts are 0.
    let inference: { content: string; prompt_tokens: number; completion_tokens: number; wallclock_ms: number };
    // Wall clock, deliberately. deliver_by is a wall-clock millisecond stamp
    // written by the buyer's builder, so this compares like with like on a live
    // chain. Under a mock backend the route derives its own "now" from the mock
    // slot instead (routes/custom.ts step 7), so the two can diverge in tests;
    // that divergence is a test-harness artifact, not a production path.
    const started = Date.now();
    // Cap the budget at whatever remains before the escrow's deliver_by, less
    // the Submit reserve, and never more than the configured service timeout.
    // A job claimed late in its window must not burn the full
    // SERVICE_TIMEOUT_MS and then miss the on-chain Submit deadline.
    const deadlineMs = Math.min(
      deps.config.serviceTimeoutMs,
      escrowDatum.deliver_by - started - SUBMIT_RESERVE_MS,
    );
    if (deadlineMs <= 0) {
      // Nothing left to work with. Fail before the operator's service is even
      // called: any result it produced could not be submitted in time, so the
      // call would cost real compute for a job that cannot settle.
      const remaining = escrowDatum.deliver_by - started;
      const message =
        `escrow deliver_by is ${remaining}ms away, which leaves no executor budget once the ` +
        `${SUBMIT_RESERVE_MS}ms Submit reserve is held back`;
      console.warn(
        `[job_failed] jobId=${jobId} reason=deliver_by_too_close httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, { httpStatus: 502, reason: "deliver_by_too_close", message });
      return;
    }
    try {
      const result = await params.executor.execute({
        capabilityId: advert.capability_id,
        requestPayload: requestBody.payload,
        deadlineMs,
        jobRef: escrowRef,
      });
      inference = {
        content: result.outputPayload,
        prompt_tokens: 0,
        completion_tokens: 0,
        wallclock_ms: Date.now() - started,
      };
    } catch (err) {
      const rawReason = err instanceof ExecutorError ? err.reason : "service_failure";
      const message = err instanceof Error ? err.message : String(err);
      // The runner's failure-code table only enumerates 502/*_failure, so the
      // narrower *_timeout reasons collapse to their *_failure sibling before
      // jobs.fail records them. The log line below keeps the raw reason, so
      // the distinction survives for debugging.
      const collapsedReason =
        rawReason === "ollama_timeout" ? "ollama_failure"
          : rawReason === "openai_timeout" ? "openai_failure"
            : rawReason;
      console.warn(
        `[job_failed] jobId=${jobId} reason=${rawReason} httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: collapsedReason,
        message,
      });
      return;
    }

    // ── 3. Build + sign receipt ────────────────────────────────────────
    const assistantMessage = { role: "assistant" as const, content: inference.content };
    const responseHash = sha256Hex(inference.content);

    const receipt = buildReceipt({
      prompt_hash: escrowDatum.prompt_hash,
      response_hash: responseHash,
      model: advert.model,
      prompt_tokens: inference.prompt_tokens,
      completion_tokens: inference.completion_tokens,
      wallclock_ms: inference.wallclock_ms,
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: escrowRef,
    });
    const signed = signReceipt(receipt, deps.supplierKey.privateKeyHex);
    const resultHash = receiptResultHash(signed);

    // ── 4+5. Submit tx: build + confirm as ONE wallet critical section ──
    const submitOutcome = await deps.state.walletMutex.run(async () => {
      let built: { txCborHex: string; expectedTxHash: string };
      try {
        built = await buildSubmitTx({
          chain: deps.chain,
          supplierKey: deps.supplierKey,
          escrowRef: claimedRef,
          receiptHash: resultHash,
        });
      } catch (err) {
        return { kind: "build_failed" as const, err };
      }
      try {
        await deps.chain.awaitTx(built.expectedTxHash, 60_000);
      } catch (err) {
        return { kind: "await_failed" as const, err };
      }
      return { kind: "ok" as const };
    });
    if (submitOutcome.kind === "build_failed") {
      const message = submitOutcome.err instanceof Error ? submitOutcome.err.message : String(submitOutcome.err);
      console.warn(
        `[job_failed] jobId=${jobId} reason=submit_failed httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_failed",
        message: `Submit tx failed: ${message}`,
      });
      return;
    }
    if (submitOutcome.kind === "await_failed") {
      const msg = submitOutcome.err instanceof Error ? submitOutcome.err.message : String(submitOutcome.err);
      console.warn(
        `[job_failed] jobId=${jobId} reason=submit_timeout httpStatus=502 msg=${msg}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_timeout",
        message: `Submit awaitTx failed: ${msg}`,
      });
      return;
    }

    // ── 6. Mark complete ────────────────────────────────────────────────
    const payload: ChatJobResponsePayload = {
      kind: "chat",
      choices: [
        {
          index: 0,
          message: assistantMessage,
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: inference.prompt_tokens,
        completion_tokens: inference.completion_tokens,
        total_tokens: inference.prompt_tokens + inference.completion_tokens,
      },
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
    };
    deps.jobs.complete(jobId, payload);
  } finally {
    // ── 7. Always release this job's slot ───────────────────────────────
    try {
      deps.state.release(escrowRef);
    } catch {
      // never let a lock-release error escape the runner
    }
  }
}
