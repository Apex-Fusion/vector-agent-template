/**
 * supplier/src/ollama.ts — HTTP client for local Ollama inference.
 *
 * callOllama({ ollamaUrl, model, messages, timeoutMs })
 *   POST to ${ollamaUrl}/api/chat with body { model, messages, stream: false }
 *   Returns { content, prompt_tokens, completion_tokens, wallclock_ms }
 *
 * Error reasons:
 *   "ollama_failure"   — non-2xx HTTP response, network error, or unexpected fetch failure
 *   "ollama_timeout"   — request exceeded timeoutMs (AbortError surfaced from AbortController)
 *   "ollama_malformed" — response body missing message.content (or content is empty/null)
 *
 * Ollama /api/chat response shape:
 *   { message: { role: "assistant", content: string },
 *     done: boolean,
 *     prompt_eval_count: number,
 *     eval_count: number,
 *     total_duration: number }   // nanoseconds — divide by 1e6 to get ms
 *
 * Implementation notes:
 *   - Uses global fetch + AbortController so tests can vi.stubGlobal("fetch", ...).
 *   - wallclock_ms is Math.floor(total_duration_ns / 1e6) — matches test that
 *     1_500_999_999 ns ⇒ 1500 ms (test accepts either 1500 or 1501; we floor).
 *   - Empty-string content is treated as malformed (test asserts).
 */

import type { ChatMessage } from "@marketplace/shared/tx";

export interface CallOllamaParams {
  ollamaUrl: string;
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
}

export interface OllamaResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
}

export type OllamaErrorReason = "ollama_failure" | "ollama_timeout" | "ollama_malformed";

export class OllamaError extends Error {
  public readonly reason: OllamaErrorReason;
  constructor(reason: OllamaErrorReason, message?: string) {
    super(message ?? reason);
    this.name = "OllamaError";
    this.reason = reason;
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === "AbortError") return true;
    // DOMException("...", "AbortError") — vitest's vi.stubGlobal path uses this
    if ((err as { code?: string }).code === "ABORT_ERR") return true;
  }
  return false;
}

export async function callOllama(params: CallOllamaParams): Promise<OllamaResult> {
  const { ollamaUrl, model, messages, timeoutMs } = params;
  const url = `${ollamaUrl}/api/chat`;
  const body = JSON.stringify({ model, messages, stream: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new OllamaError("ollama_timeout", `Ollama request exceeded ${timeoutMs}ms`);
    }
    throw new OllamaError(
      "ollama_failure",
      `Ollama fetch failed: ${(err as Error)?.message ?? String(err)}`,
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
    throw new OllamaError(
      "ollama_failure",
      `Ollama returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    throw new OllamaError(
      "ollama_malformed",
      `Ollama response was not valid JSON: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (!parsed || typeof parsed !== "object") {
    throw new OllamaError("ollama_malformed", "Ollama response was not an object");
  }

  const obj = parsed as Record<string, unknown>;
  const messageRaw = obj.message;
  if (!messageRaw || typeof messageRaw !== "object") {
    throw new OllamaError("ollama_malformed", "Ollama response missing 'message' field");
  }
  const message = messageRaw as Record<string, unknown>;
  const content = message.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new OllamaError("ollama_malformed", "Ollama response missing/empty message.content");
  }

  const promptTokens = typeof obj.prompt_eval_count === "number" ? obj.prompt_eval_count : 0;
  const completionTokens = typeof obj.eval_count === "number" ? obj.eval_count : 0;
  const totalDurationNs = typeof obj.total_duration === "number" ? obj.total_duration : 0;
  const wallclockMs = Math.floor(totalDurationNs / 1_000_000);

  return {
    content,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    wallclock_ms: wallclockMs,
  };
}
