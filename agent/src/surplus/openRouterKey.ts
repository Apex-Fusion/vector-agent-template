import { parseUsdDecimal } from "../reseller/money.js";

const MAX_KEY_RESPONSE_BYTES = 1024 * 1024;

export interface OpenRouterKeyAllowance {
  limitUsdNanos: bigint;
  remainingUsdNanos: bigint;
  reset: string | null;
  checkedAtMs: number;
}

interface OpenRouterKeyClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}

export class OpenRouterKeyClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;

  constructor(options: OpenRouterKeyClientOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}/v1/auth/key`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async readAllowance(): Promise<OpenRouterKeyAllowance> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(this.url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        redirect: "error",
        signal: controller.signal,
      });
      const text = await readBoundedText(response, controller);
      if (!response.ok) {
        throw new Error(
          `OpenRouter key endpoint returned HTTP ${response.status}`,
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new Error("OpenRouter key endpoint response was not JSON");
      }
      const root = object(body, "OpenRouter key response");
      const data = object(root.data, "OpenRouter key response.data");
      if (data.limit === null || data.limit_remaining === null) {
        throw new Error("OpenRouter resale key must have a finite spending limit");
      }
      const limit = usdNumberToNanos(data.limit, "OpenRouter key limit");
      const remaining = usdNumberToNanos(
        data.limit_remaining,
        "OpenRouter key limit_remaining",
      );
      const reset = data.limit_reset;
      if (reset !== null && reset !== undefined && typeof reset !== "string") {
        throw new Error("OpenRouter key limit_reset must be a string or null");
      }
      return {
        limitUsdNanos: limit,
        remainingUsdNanos: remaining,
        reset: typeof reset === "string" ? reset : null,
        checkedAtMs: this.now(),
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `OpenRouter allowance check failed: ${detail.replaceAll(this.apiKey, "[redacted]")}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedText(
  response: Response,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_KEY_RESPONSE_BYTES) {
        controller.abort();
        throw new Error(
          `OpenRouter key response exceeded ${MAX_KEY_RESPONSE_BYTES} bytes`,
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function usdNumberToNanos(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return parseUsdDecimal(value.toFixed(9), "floor");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
