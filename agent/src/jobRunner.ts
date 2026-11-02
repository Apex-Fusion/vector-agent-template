/**
 * supplier/src/jobRunner.ts — Background async chat job runner.
 *
 * M1-F-async-chat-green — Catherine, 2026-04-28.
 * M1-F-async-chat-cleanup-green — Catherine, 2026-04-24.
 *
 * Invoked fire-and-forget from POST /v1/responses after Claim confirms.
 * Steps:
 *   1. jobs.setRunning(jobId)
 *   2. call the configured Responses or Ollama adapter
 *   3. build + sign receipt
 *   4. construct + submit Submit tx via buildSubmitTx()
 *      [on rejection: jobs.fail("submit_failed")]
 *   5. await Submit tx confirmation (60s budget)
 *      [on rejection: jobs.fail("submit_timeout")]
 *   6. jobs.complete(jobId, payload)
 *   7. release supplier lock                      [ALWAYS, in try/finally]
 *
 * The function NEVER throws — all errors are captured into jobs.fail.
 *
 * Cleanup history: an earlier RED phase did not seed claimedRef in the chain
 * mock; the runner used an inline JSON-in-hex Submit body and a 200ms awaitTx
 * with a poll-timeout regex discriminator. Caroline's cleanup-RED migrated
 * fixtures to seed claimedRef and mock awaitTx, so we now flip back to the
 * canonical buildSubmitTx + 60_000ms awaitTx budget.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import { canonicalize } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import {
  createResponse,
  responseInputToChatMessages,
  responseResultCommitment,
  type ResponseObject,
  type ResponseRequest,
} from "@marketplace/shared/responses";
import { createHash } from "crypto";

import type { SupplierState } from "./state.js";
import type { SupplierConfig } from "./config.js";
import * as ollama from "./ollama.js";
import * as openai from "./openai.js";
import * as piper from "./piper.js";
import * as ocrVision from "./ocrVision.js";
import * as datalabOcr from "./datalabOcr.js";
import type { OcrRequest } from "@marketplace/shared/tx";
import type {
  JobStore,
  ChatJobResponsePayload,
  TtsJobResponsePayload,
  OcrJobResponsePayload,
} from "./jobs.js";
import type { ResellerRuntime } from "./reseller/runtime.js";
import { parseUsdNumberCeil } from "./reseller/money.js";
import { identityOptions, receiptAgentDid, type SupplierIdentity } from "./identity/agent.js";

export interface RunChatJobDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  jobs: JobStore;
  reseller?: ResellerRuntime;
  /** Record lookup and identity blueprint for the Submit of a new escrow. */
  identity?: SupplierIdentity;
}

export interface RunChatJobParams {
  deps: RunChatJobDeps;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  requestBody: ResponseRequest;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

async function recordResellerFailure(
  reseller: ResellerRuntime | undefined,
  escrowRef: string,
  reason: string,
): Promise<void> {
  if (!reseller) return;
  await reseller.recordFailed(escrowRef, reason).catch(() => undefined);
}

/**
 * Run the configured LLM → receipt → Submit in the background.
 * Always resolves (never rejects). Terminal state is written to the job store.
 * The supplier lock is released in try/finally regardless of outcome.
 */
export async function runChatJob(params: RunChatJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  // ── 1. Mark job running BEFORE Ollama (ordering pin) ─────────────────
  deps.jobs.setRunning(jobId);

  try {
    if (deps.reseller) {
      try {
        await deps.reseller.recordInferenceStarted(escrowRef);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.jobs.fail(jobId, {
          httpStatus: 503,
          reason: "evidence_unavailable",
          message,
        });
        return;
      }
    }

    // ── 2. Call upstream LLM ───────────────────────────────────────────
    let inference: {
      response: ResponseObject;
      content: string;
      prompt_tokens: number;
      completion_tokens: number;
      wallclock_ms: number;
      cost_usd?: number;
    };
    try {
      if (deps.config.llmBackend === "openai") {
        inference = await openai.callResponses({
          baseUrl: deps.config.openaiBaseUrl,
          responsesUrl: deps.config.openaiResponsesUrl || undefined,
          responsesStreamOnly: deps.config.openaiResponsesStreamOnly,
          upstreamApi: deps.config.openaiUpstreamApi,
          model: deps.config.openaiModelOverride || advert.model,
          ...requestBody,
          timeoutMs: deps.config.openaiTimeoutMs,
          apiKey: deps.config.openaiApiKey,
          maxTokens: deps.config.openaiMaxTokens,
          disableReasoning: deps.config.openaiReasoningDisabled,
        });
      } else {
        const ollamaResult = await ollama.callOllama({
          ollamaUrl: deps.config.ollamaUrl,
          model: advert.model,
          messages: responseInputToChatMessages(requestBody.input, requestBody.instructions),
          timeoutMs: deps.config.ollamaTimeoutMs,
          maxOutputTokens: requestBody.max_output_tokens,
        });
        const responseStatus =
          ollamaResult.done_reason === "length" ? "incomplete" : "completed";
        const response = createResponse({
          id: `resp_${jobId}`,
          model: advert.model,
          status: responseStatus,
          incomplete_details:
            responseStatus === "incomplete" ? { reason: "max_output_tokens" } : null,
          output: [{
            type: "message",
            id: `msg_${jobId}`,
            role: "assistant",
            status: responseStatus,
            content: [{ type: "output_text", text: ollamaResult.content, annotations: [] }],
          }],
          usage: {
            input_tokens: ollamaResult.prompt_tokens,
            output_tokens: ollamaResult.completion_tokens,
            total_tokens: ollamaResult.prompt_tokens + ollamaResult.completion_tokens,
          },
        });
        inference = {
          response,
          content: ollamaResult.content,
          prompt_tokens: ollamaResult.prompt_tokens,
          completion_tokens: ollamaResult.completion_tokens,
          wallclock_ms: ollamaResult.wallclock_ms,
        };
      }
    } catch (err) {
      const rawReason =
        (err as ollama.OllamaError | openai.OpenAiError)?.reason ??
        (deps.config.llmBackend === "openai" ? "openai_failure" : "ollama_failure");
      const message = err instanceof Error ? err.message : String(err);
      // *_timeout maps to httpStatus 502 here per Caroline's pin (the runner
      // failure-code table only enumerates 502/*_failure). The narrower
      // timeout reason is collapsed to the failure reason for jobs.fail.
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
      await recordResellerFailure(deps.reseller, escrowRef, collapsedReason);
      return;
    }

    // ── 3. Build + sign receipt ────────────────────────────────────────
    const responseHash = sha256Hex(canonicalize(responseResultCommitment(inference.response)));

    const receipt = buildReceipt({
      prompt_hash: escrowDatum.prompt_hash,
      response_hash: responseHash,
      model: advert.model,
      prompt_tokens: inference.prompt_tokens,
      completion_tokens: inference.completion_tokens,
      wallclock_ms: inference.wallclock_ms,
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: escrowRef,
      ...receiptAgentDid(escrowDatum),
    });
    const signed = signReceipt(receipt, deps.supplierKey.privateKeyHex);
    const resultHash = receiptResultHash(signed);
    if (deps.reseller) {
      try {
        await deps.reseller.recordOutput(escrowRef, {
          response: inference.response,
          receipt: {
            receipt: signed.receipt,
            signature: signed.signature,
          },
          promptTokens: inference.prompt_tokens,
          completionTokens: inference.completion_tokens,
          outputText: inference.content,
          actualCostUsdNanos: inference.cost_usd === undefined
            ? null
            : parseUsdNumberCeil(inference.cost_usd, "OpenRouter usage cost"),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.jobs.fail(jobId, {
          httpStatus: 503,
          reason: "evidence_unavailable",
          message,
        });
        await recordResellerFailure(
          deps.reseller,
          escrowRef,
          "output_persistence_failed",
        );
        return;
      }
    }


    // ── 4+5. Broadcast, journal, then confirm Submit under one wallet lock ─
    const submitOutcome = await deps.state.walletMutex.run(async () => {
      let built: { txCborHex: string; expectedTxHash: string };
      try {
        built = await buildSubmitTx({
          chain: deps.chain,
          supplierKey: deps.supplierKey,
          escrowRef: claimedRef,
          receiptHash: resultHash,
          ...identityOptions(escrowDatum, deps.identity),
          beforeSubmit: deps.reseller
            ? async (candidate) => {
                await deps.reseller!.recordSubmitting(
                  escrowRef,
                  `${candidate.expectedTxHash}#0`,
                );
              }
            : undefined,
        });
      } catch (err) {
        return { kind: "build_failed" as const, err };
      }
      const submittedRef = `${built.expectedTxHash}#0`;
      try {
        await deps.chain.awaitTx(built.expectedTxHash, 60_000);
      } catch (err) {
        return { kind: "await_failed" as const, err, built, submittedRef };
      }
      return { kind: "ok" as const, built, submittedRef };
    });
    if (submitOutcome.kind === "build_failed") {
      const message = submitOutcome.err instanceof Error
        ? submitOutcome.err.message
        : String(submitOutcome.err);
      console.warn(
        `[job_failed] jobId=${jobId} reason=submit_failed httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_failed",
        message: `Submit tx failed: ${message}`,
      });
      await recordResellerFailure(deps.reseller, escrowRef, "submit_failed");
      return;
    }
    if (submitOutcome.kind === "await_failed") {
      const message = submitOutcome.err instanceof Error
        ? submitOutcome.err.message
        : String(submitOutcome.err);
      console.warn(
        `[job_failed] jobId=${jobId} reason=submit_timeout httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: "submit_timeout",
        message: `Submit awaitTx failed: ${message}`,
      });
      deps.reseller?.watchSubmitting(escrowRef, submitOutcome.submittedRef);
      return;
    }
    if (deps.reseller) {
      try {
        await deps.reseller.recordSubmitConfirmed(
          escrowRef,
          submitOutcome.submittedRef,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.jobs.fail(jobId, {
          httpStatus: 503,
          reason: "evidence_unavailable",
          message,
        });
        deps.reseller.watchSubmitting(escrowRef, submitOutcome.submittedRef);
        return;
      }
    }


    // ── 6. Mark complete ────────────────────────────────────────────────
    const payload: ChatJobResponsePayload = {
      ...inference.response,
      // The marketplace model is the advert's routing identity; providers may
      // return a resolved snapshot name or an explicitly configured override.
      model: advert.model,
      kind: "chat",
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
      submitted_ref: submitOutcome.submittedRef,
    };
    deps.jobs.complete(jobId, payload);
  } finally {
    if (deps.reseller) {
      await deps.reseller.refreshCapacity().catch(() => undefined);
    }
    // ── 7. Always release this job's slot ───────────────────────────────
    try {
      deps.state.release(escrowRef);
    } catch {
      // never let a lock-release error escape the runner
    }
  }
}

// ─── runTtsJob ────────────────────────────────────────────────────────────
//
// Mirror of runChatJob for the audio.synthesize.piper.v1 capability. Same
// 7-step shape (setRunning → upstream → receipt → buildSubmit → awaitTx →
// complete → finally release). Differences from chat path:
//
//   - Upstream is `piper.callPiper` returning audio bytes + content-type.
//   - response_hash = sha256(audio_bytes), unlike the LLM terminal-result commitment.
//   - prompt_tokens / completion_tokens are 0 because Piper has no token usage;
//     the on-chain validator does not read these off-chain billing fields.
//   - JobStore terminal payload is `TtsJobResponsePayload` with audio_b64.

export interface RunTtsJobParams {
  deps: RunChatJobDeps;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  /** The TTS request body fields. The PROMPT_HASH committed by the buyer in
   * the escrow datum is sha256(canonicalize(this same object)), so the
   * supplier reproduces that hash and validates it before claiming. */
  requestBody: { text: string; voice: string; format: string; speed: number };
}

function sha256BytesHex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function runTtsJob(params: RunTtsJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  deps.jobs.setRunning(jobId);

  try {
    // ── 2. Call Piper ─────────────────────────────────────────────────
    let inference: piper.PiperResult;
    try {
      inference = await piper.callPiper({
        piperUrl: deps.config.piperUrl,
        text: requestBody.text,
        voice: requestBody.voice,
        format: requestBody.format,
        speed: requestBody.speed,
        timeoutMs: deps.config.piperTimeoutMs,
      });
    } catch (err) {
      const reason = (err as piper.PiperError)?.reason ?? "piper_failure";
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[job_failed] jobId=${jobId} reason=${reason} httpStatus=502 msg=${message}`,
      );
      deps.jobs.fail(jobId, {
        httpStatus: 502,
        reason: reason === "piper_timeout" ? "piper_failure" : reason,
        message,
      });
      return;
    }

    // ── 3. Build + sign receipt ───────────────────────────────────────
    const responseHash = sha256BytesHex(inference.audio);

    const receipt = buildReceipt({
      prompt_hash: escrowDatum.prompt_hash,
      response_hash: responseHash,
      model: advert.model,
      // Piper has no token semantics — pin both to 0 so the field is present
      // but doesn't masquerade as a real token count. Off-chain only; the
      // validator never reads these.
      prompt_tokens: 0,
      completion_tokens: 0,
      wallclock_ms: inference.wallclock_ms,
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: escrowRef,
      ...receiptAgentDid(escrowDatum),
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
          ...identityOptions(escrowDatum, deps.identity),
        });
      } catch (err) {
        return { kind: "build_failed" as const, err };
      }
      // The Submit tx output (index 0) is the new Submitted UTxO the buyer Accepts.
      const submittedRef = `${built.expectedTxHash}#0`;
      try {
        await deps.chain.awaitTx(built.expectedTxHash, 60_000);
      } catch (err) {
        return { kind: "await_failed" as const, err };
      }
      return { kind: "ok" as const, submittedRef };
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

    // ── 6. Mark complete ──────────────────────────────────────────────
    const audio_b64 = Buffer.from(inference.audio).toString("base64");
    const payload: TtsJobResponsePayload = {
      kind: "tts",
      audio_b64,
      format: requestBody.format,
      content_type: inference.contentType,
      byte_length: inference.audio.byteLength,
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
      submitted_ref: submitOutcome.submittedRef,
    };
    deps.jobs.complete(jobId, payload);
  } finally {
    try {
      deps.state.release(escrowRef);
    } catch {
      /* never let lock-release escape */
    }
  }
}

// ─── runOcrJob ────────────────────────────────────────────────────────────
//
// Mirror of runTtsJob for model-scoped `ocr.page.extract.<model-slug>.v1`
// capabilities. Same 7-step shape (setRunning → upstream → receipt →
// buildSubmit → awaitTx → complete → finally release). Differences from the
// TTS path:
//
//   - Upstream is `ocrVision.callOcrVision` against an OpenAI-compatible
//     VISION endpoint (vLLM serving e.g. datalab-to/chandra-ocr-2); the
//     one-page image rides as a data-URL content part.
//   - response_hash = sha256(canonical({content, output_format})) — commits
//     the extraction text AND the shape it was requested in.
//   - prompt_tokens / completion_tokens come from upstream usage (vision
//     tokens are real tokens, unlike Piper).

export interface RunOcrJobParams {
  deps: RunChatJobDeps;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  /** The OCR request envelope. The PROMPT_HASH committed by the buyer in
   * the escrow datum is sha256(canonicalize(this same object)), validated
   * by the route before Claim. */
  requestBody: OcrRequest;
}

export async function runOcrJob(params: RunOcrJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  deps.jobs.setRunning(jobId);

  try {
    // ── 2. Call the OCR upstream (openai-vision or datalab) ───────────
    let inference: ocrVision.OcrVisionResult;
    try {
      if (deps.config.ocrUpstream === "datalab") {
        inference = await datalabOcr.callDatalabOcr({
          baseUrl: deps.config.datalabBaseUrl,
          apiKey: deps.config.datalabApiKey,
          request: requestBody,
          timeoutMs: deps.config.datalabTimeoutMs,
          mode: deps.config.datalabMode,
        });
      } else {
        const configuredMax = deps.config.openaiMaxTokens;
        const maxTokens =
          configuredMax > 0
            ? Math.min(configuredMax, advert.max_output_tokens)
            : advert.max_output_tokens;
        inference = await ocrVision.callOcrVision({
          baseUrl: deps.config.openaiBaseUrl,
          model: advert.model,
          request: requestBody,
          timeoutMs: deps.config.openaiTimeoutMs,
          apiKey: deps.config.openaiApiKey,
          maxTokens,
          promptOverride: deps.config.ocrPromptOverride,
        });
      }
    } catch (err) {
      const rawReason =
        (err as ocrVision.OcrVisionError | datalabOcr.DatalabError)?.reason ??
        (deps.config.ocrUpstream === "datalab" ? "datalab_failure" : "ocr_failure");
      const message = err instanceof Error ? err.message : String(err);
      // *_timeout collapses to the failure reason for jobs.fail, matching
      // the chat/tts runner failure-code table (502 only).
      const collapsedReason =
        rawReason === "ocr_timeout" ? "ocr_failure"
          : rawReason === "datalab_timeout" ? "datalab_failure"
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

    // ── 3. Build + sign receipt ───────────────────────────────────────
    const responseHash = sha256Hex(canonicalize({
      content: inference.content,
      output_format: requestBody.output_format,
    }));

    const receipt = buildReceipt({
      prompt_hash: escrowDatum.prompt_hash,
      response_hash: responseHash,
      model: advert.model,
      prompt_tokens: inference.prompt_tokens,
      completion_tokens: inference.completion_tokens,
      wallclock_ms: inference.wallclock_ms,
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: escrowRef,
      ...receiptAgentDid(escrowDatum),
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
          ...identityOptions(escrowDatum, deps.identity),
        });
      } catch (err) {
        return { kind: "build_failed" as const, err };
      }
      const submittedRef = `${built.expectedTxHash}#0`;
      try {
        await deps.chain.awaitTx(built.expectedTxHash, 60_000);
      } catch (err) {
        return { kind: "await_failed" as const, err };
      }
      return { kind: "ok" as const, submittedRef };
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

    // ── 6. Mark complete ──────────────────────────────────────────────
    const payload: OcrJobResponsePayload = {
      kind: "ocr",
      output_format: requestBody.output_format,
      content: inference.content,
      usage: {
        prompt_tokens: inference.prompt_tokens,
        completion_tokens: inference.completion_tokens,
        total_tokens: inference.prompt_tokens + inference.completion_tokens,
      },
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
      submitted_ref: submitOutcome.submittedRef,
    };
    deps.jobs.complete(jobId, payload);
  } finally {
    try {
      deps.state.release(escrowRef);
    } catch {
      /* never let lock-release escape */
    }
  }
}
