/**
 * supplier/src/ocrVision.ts — HTTP client for an OpenAI-compatible VISION
 * /v1/chat/completions endpoint (vLLM serving an OCR VLM, e.g.
 * datalab-to/chandra-ocr-2). Used by the `ocr` capability kind.
 *
 * callOcrVision({ baseUrl, model, request, timeoutMs, ... })
 *   POST ${baseUrl}/v1/chat/completions with a single user message whose
 *   content is OpenAI vision content parts:
 *     [{type:"image_url", image_url:{url:"data:<mime>;base64,<b64>"}},
 *      {type:"text", text:<instruction for the output format>}]
 *   Returns { content, prompt_tokens, completion_tokens, wallclock_ms }
 *   — the same shape as ollama.ts / openai.ts so receipt construction is
 *   identical downstream.
 *
 * The instruction text per output_format is a serving-side implementation
 * detail (like temperature); the buyer's on-chain commitment covers the
 * OcrRequest envelope, not the serving prompt. The exact Chandra prompt
 * convention gets pinned against a live endpoint during integration —
 * override per deployment via OCR_PROMPT_OVERRIDE without a code change.
 *
 * Error reasons:
 *   "ocr_failure"   — non-2xx HTTP, network error, unexpected fetch failure
 *   "ocr_timeout"   — request exceeded timeoutMs
 *   "ocr_malformed" — response missing choices[0].message.content (or empty)
 *
 * probeRevision() — best-effort served-checkpoint probe (light v0). GETs a
 * runtime info route and extracts a revision/SHA field if one is present.
 * The route handler refuses to Claim on a mismatch when a pin is
 * configured. When the receipt schema is extended to carry it, the probed
 * value feeds `model_revision`; until then it is a claim gate and
 * a log line.
 */

import type { OcrRequest } from "@marketplace/shared/tx";

export interface CallOcrVisionParams {
  baseUrl: string;
  model: string;
  request: OcrRequest;
  timeoutMs: number;
  /** Optional bearer token (hosted endpoints). "" sends no header. */
  apiKey?: string;
  /** Hard output-token ceiling forwarded as max_tokens when > 0. */
  maxTokens?: number;
  /** Overrides the built-in per-format instruction when non-empty. */
  promptOverride?: string;
}

export interface OcrVisionResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
}

export type OcrVisionErrorReason = "ocr_failure" | "ocr_timeout" | "ocr_malformed";

export class OcrVisionError extends Error {
  public readonly reason: OcrVisionErrorReason;
  constructor(reason: OcrVisionErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "OcrVisionError";
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

/** Default extraction instructions per output_format. Placeholder wording
 * pending the Chandra-convention pin (integration item); serving deployments
 * override via OCR_PROMPT_OVERRIDE. */
export function defaultOcrInstruction(outputFormat: string): string {
  switch (outputFormat) {
    case "html":
      return "Convert this document page to clean, semantic HTML. Preserve reading order, tables, form fields and layout structure. Output only the HTML.";
    case "json":
      return "Extract this document page as JSON with layout blocks (type, bbox, text) preserving reading order, tables and form fields. Output only the JSON.";
    case "markdown":
    default:
      return "Convert this document page to clean markdown. Preserve reading order, tables and structure. Transcribe handwriting faithfully. Output only the markdown.";
  }
}

export async function callOcrVision(params: CallOcrVisionParams): Promise<OcrVisionResult> {
  const { baseUrl, model, request, timeoutMs, apiKey, maxTokens, promptOverride } = params;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;

  const instruction =
    promptOverride && promptOverride.length > 0
      ? promptOverride
      : defaultOcrInstruction(request.output_format);

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:${request.mime};base64,${request.image_b64}` },
          },
          { type: "text", text: instruction },
        ],
      },
    ],
    stream: false,
  };
  if (typeof maxTokens === "number" && maxTokens > 0) payload.max_tokens = maxTokens;
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new OcrVisionError("ocr_timeout", `OCR request exceeded ${timeoutMs}ms`);
    }
    throw new OcrVisionError(
      "ocr_failure",
      `OCR fetch failed: ${(err as Error)?.message ?? String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore — body unavailable
    }
    throw new OcrVisionError(
      "ocr_failure",
      `OCR upstream returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new OcrVisionError(
      "ocr_malformed",
      `OCR response was not valid JSON: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new OcrVisionError("ocr_malformed", "OCR response was not an object");
  }

  const obj = parsed as Record<string, unknown>;
  const choicesRaw = obj.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new OcrVisionError("ocr_malformed", "OCR response missing 'choices' array");
  }
  const firstChoice = choicesRaw[0];
  if (!firstChoice || typeof firstChoice !== "object") {
    throw new OcrVisionError("ocr_malformed", "OCR response choices[0] not an object");
  }
  const messageRaw = (firstChoice as Record<string, unknown>).message;
  if (!messageRaw || typeof messageRaw !== "object") {
    throw new OcrVisionError("ocr_malformed", "OCR response missing 'choices[0].message'");
  }
  const content = (messageRaw as Record<string, unknown>).content;
  if (typeof content !== "string" || content.length === 0) {
    throw new OcrVisionError(
      "ocr_malformed",
      "OCR response missing/empty choices[0].message.content",
    );
  }

  const usageRaw = obj.usage;
  let promptTokens = 0;
  let completionTokens = 0;
  if (usageRaw && typeof usageRaw === "object") {
    const usage = usageRaw as Record<string, unknown>;
    if (typeof usage.prompt_tokens === "number") promptTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") completionTokens = usage.completion_tokens;
  }

  return {
    content,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    wallclock_ms: Date.now() - startedAt,
  };
}

// ─── Revision probe (light v0) ──────────────────────────────────────────────

export interface ProbeRevisionParams {
  probeUrl: string;
  timeoutMs: number;
  apiKey?: string;
}

export interface ProbeRevisionResult {
  ok: boolean;
  /** 40-hex checkpoint SHA when the runtime reports one; "" otherwise. */
  servedSha: string;
  /** Human-readable detail for logs/alerts. */
  detail: string;
}

const SHA40_RE = /^[0-9a-f]{40}$/i;

/** Fields observed across serving runtimes that carry a checkpoint id
 * (TGI /info: model_sha; vLLM variants: sha / revision / model_revision). */
const SHA_FIELDS = ["model_sha", "sha", "revision", "model_revision"];

export async function probeRevision(params: ProbeRevisionParams): Promise<ProbeRevisionResult> {
  const { probeUrl, timeoutMs, apiKey } = params;
  const headers: Record<string, string> = {};
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(probeUrl, { headers, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, servedSha: "", detail: `probe HTTP ${response.status}` };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ok: false, servedSha: "", detail: "probe response not JSON" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { ok: false, servedSha: "", detail: "probe response not an object" };
    }
    const obj = parsed as Record<string, unknown>;
    for (const field of SHA_FIELDS) {
      const v = obj[field];
      if (typeof v === "string" && SHA40_RE.test(v)) {
        return { ok: true, servedSha: v.toLowerCase(), detail: `probe ${field}=${v}` };
      }
    }
    return { ok: true, servedSha: "", detail: "probe answered without a revision field" };
  } catch (err) {
    const msg = isAbortError(err)
      ? `probe exceeded ${timeoutMs}ms`
      : `probe failed: ${(err as Error)?.message ?? String(err)}`;
    return { ok: false, servedSha: "", detail: msg };
  } finally {
    clearTimeout(timer);
  }
}
