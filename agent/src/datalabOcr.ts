/**
 * supplier/src/datalabOcr.ts — HTTP client for the Datalab hosted document
 * API (https://www.datalab.to), used when OCR_UPSTREAM="datalab".
 *
 * Contract (verified against documentation.datalab.to, 2026-08-06):
 *   POST {base}/api/v1/convert            multipart/form-data, X-API-Key
 *     fields: file (binary), output_format (markdown|html|json), mode
 *     → { success, error, request_id, request_check_url }
 *   GET  {base}/api/v1/convert/{id}       X-API-Key
 *     → { status: "complete" | ..., markdown|html|json, page_count, error }
 *
 * callDatalabOcr() submits ONE page image and polls until complete, then
 * returns the SAME result shape as ocrVision.callOcrVision so runOcrJob's
 * receipt construction is shared. Token counts are pinned to 0 — the
 * Datalab API has no token semantics (mirrors the Piper/TTS convention);
 * wallclock_ms brackets submit→complete locally.
 *
 * JSON output: when output_format="json" the result field can be an object;
 * it is serialized with JSON.stringify to keep `content` a string. The
 * receipt commits sha256(canonical({content, output_format})) over exactly
 * the string the buyer receives, so determinism holds regardless.
 *
 * Error reasons (mirror the taxonomy of the other adapters):
 *   "datalab_failure"   — non-2xx, network error, success:false, job error
 *   "datalab_timeout"   — submit+poll exceeded timeoutMs
 *   "datalab_malformed" — response JSON missing the expected fields
 *
 * probeDatalabHealth() — pre-Claim liveness gate for the route (the
 * revision-probe slot repurposed for hosted supply): GETs {base}/api/v1/health
 * with the API key; a non-OK answer refuses the Claim so escrows are not
 * stranded behind a dead upstream.
 */

import type { OcrRequest } from "@marketplace/shared/tx";
import type { OcrVisionResult } from "./ocrVision.js";

export interface CallDatalabOcrParams {
  /** API origin, no trailing slash. Default deployment: https://www.datalab.to */
  baseUrl: string;
  apiKey: string;
  request: OcrRequest;
  /** Whole-call budget: submit + polling until complete. */
  timeoutMs: number;
  /** Datalab quality mode: fast | balanced | accurate. */
  mode: string;
  /** Poll cadence; overridable in tests. Default 2000. */
  pollIntervalMs?: number;
}

export type DatalabErrorReason = "datalab_failure" | "datalab_timeout" | "datalab_malformed";

export class DatalabError extends Error {
  public readonly reason: DatalabErrorReason;
  constructor(reason: DatalabErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "DatalabError";
    this.reason = reason;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    }, { once: true });
  });
}

export async function callDatalabOcr(params: CallDatalabOcrParams): Promise<OcrVisionResult> {
  const { baseUrl, apiKey, request, timeoutMs, mode } = params;
  const pollIntervalMs = params.pollIntervalMs ?? 2_000;
  const base = baseUrl.replace(/\/+$/, "");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    // ── 1. Submit ─────────────────────────────────────────────────────
    const form = new FormData();
    const bytes = Buffer.from(request.image_b64, "base64");
    const ext = EXT_BY_MIME[request.mime] ?? "png";
    form.append("file", new Blob([bytes], { type: request.mime }), `page.${ext}`);
    form.append("output_format", request.output_format);
    form.append("mode", mode);

    let submitRes: Response;
    try {
      submitRes = await fetch(`${base}/api/v1/convert`, {
        method: "POST",
        headers: { "X-API-Key": apiKey },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        throw new DatalabError("datalab_timeout", `Datalab submit exceeded ${timeoutMs}ms`);
      }
      throw new DatalabError("datalab_failure",
        `Datalab submit failed: ${(err as Error)?.message ?? String(err)}`);
    }
    if (!submitRes.ok) {
      let detail = "";
      try { detail = await submitRes.text(); } catch { /* body unavailable */ }
      throw new DatalabError("datalab_failure",
        `Datalab submit returned HTTP ${submitRes.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    let submitBody: Record<string, unknown>;
    try {
      submitBody = await submitRes.json() as Record<string, unknown>;
    } catch {
      throw new DatalabError("datalab_malformed", "Datalab submit response was not JSON");
    }
    if (submitBody.success !== true) {
      throw new DatalabError("datalab_failure",
        `Datalab submit success=false: ${String(submitBody.error ?? "no error detail")}`);
    }
    const requestId = submitBody.request_id;
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new DatalabError("datalab_malformed", "Datalab submit response missing request_id");
    }

    // ── 2. Poll until complete ────────────────────────────────────────
    const checkUrl = typeof submitBody.request_check_url === "string" && submitBody.request_check_url.length > 0
      ? submitBody.request_check_url
      : `${base}/api/v1/convert/${requestId}`;

    for (;;) {
      let pollRes: Response;
      try {
        pollRes = await fetch(checkUrl, {
          headers: { "X-API-Key": apiKey },
          signal: controller.signal,
        });
      } catch (err) {
        if (isAbortError(err)) {
          throw new DatalabError("datalab_timeout", `Datalab poll exceeded ${timeoutMs}ms budget`);
        }
        throw new DatalabError("datalab_failure",
          `Datalab poll failed: ${(err as Error)?.message ?? String(err)}`);
      }
      if (!pollRes.ok) {
        throw new DatalabError("datalab_failure", `Datalab poll returned HTTP ${pollRes.status}`);
      }
      let poll: Record<string, unknown>;
      try {
        poll = await pollRes.json() as Record<string, unknown>;
      } catch {
        throw new DatalabError("datalab_malformed", "Datalab poll response was not JSON");
      }

      const status = typeof poll.status === "string" ? poll.status.toLowerCase() : "";
      if (status === "complete") {
        if (poll.error && typeof poll.error === "string" && poll.error.length > 0) {
          throw new DatalabError("datalab_failure", `Datalab conversion error: ${poll.error}`);
        }
        const raw = poll[request.output_format];
        let content: string;
        if (typeof raw === "string") {
          content = raw;
        } else if (raw !== null && raw !== undefined && typeof raw === "object") {
          content = JSON.stringify(raw);
        } else {
          throw new DatalabError("datalab_malformed",
            `Datalab result missing "${request.output_format}" field`);
        }
        if (content.length === 0) {
          throw new DatalabError("datalab_malformed", "Datalab result content is empty");
        }
        return {
          content,
          prompt_tokens: 0,
          completion_tokens: 0,
          wallclock_ms: Date.now() - startedAt,
        };
      }
      if (status === "failed" || status === "error") {
        throw new DatalabError("datalab_failure",
          `Datalab conversion status=${status}: ${String(poll.error ?? "no detail")}`);
      }

      try {
        await sleep(pollIntervalMs, controller.signal);
      } catch (err) {
        if (isAbortError(err)) {
          throw new DatalabError("datalab_timeout", `Datalab poll exceeded ${timeoutMs}ms budget`);
        }
        throw err;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── Liveness probe (pre-Claim gate for hosted supply) ─────────────────────

export interface ProbeDatalabParams {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export interface ProbeDatalabResult {
  ok: boolean;
  detail: string;
}

export async function probeDatalabHealth(params: ProbeDatalabParams): Promise<ProbeDatalabResult> {
  const base = params.baseUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(`${base}/api/v1/health`, {
      headers: { "X-API-Key": params.apiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, detail: `health HTTP ${res.status}` };
    }
    return { ok: true, detail: "health ok" };
  } catch (err) {
    const msg = isAbortError(err)
      ? `health probe exceeded ${params.timeoutMs}ms`
      : `health probe failed: ${(err as Error)?.message ?? String(err)}`;
    return { ok: false, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
