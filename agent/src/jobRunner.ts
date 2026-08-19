/**
 * supplier/src/jobRunner.ts — Background async chat job runner.
 *
 * M1-F-async-chat-green — Catherine, 2026-04-28.
 * M1-F-async-chat-cleanup-green — Catherine, 2026-04-24.
 *
 * Invoked fire-and-forget from the POST chat handler after Claim tx confirms.
 * Steps (per Caroline's tests, ordering pinned):
 *   1. jobs.setRunning(jobId)                    [BEFORE callOllama — ordering pin]
 *   2. callOllama(...)                            [on rejection: jobs.fail("ollama_failure")]
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
import type { WalletKey, ChatMessage } from "@marketplace/shared/tx";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
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
  JobResponsePayload,
  ChatJobResponsePayload,
  TtsJobResponsePayload,
  OcrJobResponsePayload,
} from "./jobs.js";

export interface RunChatJobDeps {
  chain: ChainProvider;
  state: SupplierState;
  config: SupplierConfig;
  supplierKey: WalletKey;
  jobs: JobStore;
}

export interface RunChatJobParams {
  deps: RunChatJobDeps;
  jobId: string;
  escrowRef: string;
  claimedRef: OutputReference;
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  requestBody: { messages: ChatMessage[] };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Run Ollama → receipt → Submit in the background.
 * Always resolves (never rejects). Terminal state written to jobs store.
 * Supplier lock is released in try/finally regardless of outcome.
 */
export async function runChatJob(params: RunChatJobParams): Promise<void> {
  const { deps, jobId, escrowRef, claimedRef, advert, escrowDatum, requestBody } = params;

  // ── 1. Mark job running BEFORE Ollama (ordering pin) ─────────────────
  deps.jobs.setRunning(jobId);

  try {
    // ── 2. Call upstream LLM ───────────────────────────────────────────
    // Both backends return the same { content, prompt_tokens,
    // completion_tokens, wallclock_ms } shape so receipt construction
    // downstream is identical.
    let inference: { content: string; prompt_tokens: number; completion_tokens: number; wallclock_ms: number };
    try {
      if (deps.config.llmBackend === "openai") {
        inference = await openai.callOpenAi({
          baseUrl: deps.config.openaiBaseUrl,
          model: deps.config.openaiModelOverride || advert.model,
          messages: requestBody.messages,
          timeoutMs: deps.config.openaiTimeoutMs,
          apiKey: deps.config.openaiApiKey,
          maxTokens: deps.config.openaiMaxTokens,
          disableReasoning: deps.config.openaiReasoningDisabled,
        });
      } else {
        inference = await ollama.callOllama({
          ollamaUrl: deps.config.ollamaUrl,
          model: advert.model,
          messages: requestBody.messages,
          timeoutMs: deps.config.ollamaTimeoutMs,
        });
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
      return;
    }

    // ── 3. Build + sign receipt ────────────────────────────────────────
    const assistantMessage = { role: "assistant" as const, content: inference.content };
    const responseHash = sha256Hex(canonicalize(assistantMessage));

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

// ─── runTtsJob ────────────────────────────────────────────────────────────
//
// Mirror of runChatJob for the audio.synthesize.piper.v1 capability. Same
// 7-step shape (setRunning → upstream → receipt → buildSubmit → awaitTx →
// complete → finally release). Differences from chat path:
//
//   - Upstream is `piper.callPiper` returning audio bytes + content-type,
//     not Ollama returning text + token counts.
//   - response_hash = sha256(audio_bytes) — opaque-bytes commitment, in
//     contrast to chat which hashes a canonicalised assistant message JSON.
//   - prompt_tokens / completion_tokens are reported as 0 in the receipt;
//     Piper has no token concept and the on-chain validator doesn't read
//     these fields (they're off-chain billing metadata only).
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
