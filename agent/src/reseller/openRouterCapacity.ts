import type {
  CapacityProvider,
  ProviderCapacityReading,
  ProviderModelPricing,
} from "./provider.js";
import { parseUsdDecimal, parseUsdNumberFloor } from "./money.js";

interface OpenRouterCapacityOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  pricingCacheMs?: number;
  fetchFn?: typeof globalThis.fetch;
  now?: () => number;
}

export class OpenRouterCapacityProvider implements CapacityProvider {
  readonly id = "openrouter";

  private readonly apiRoot: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly pricingCacheMs: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly now: () => number;
  private pricingCache: ProviderModelPricing | null = null;

  constructor(options: OpenRouterCapacityOptions) {
    this.apiRoot = `${options.baseUrl.replace(/\/+$/, "")}/v1`;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs;
    this.pricingCacheMs = options.pricingCacheMs ?? 300_000;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  async readCapacity(model: string): Promise<ProviderCapacityReading> {
    const [key, pricing] = await Promise.all([
      this.readKeyLimit(),
      this.readModelPricing(model),
    ]);
    return {
      provider: this.id,
      keyLimitUsdNanos: key.limit,
      keyRemainingUsdNanos: key.remaining,
      limitReset: key.reset,
      pricing,
      checkedAtMs: this.now(),
    };
  }

  private async readKeyLimit(): Promise<{
    limit: bigint;
    remaining: bigint;
    reset: string | null;
  }> {
    const body = await this.fetchJson(`${this.apiRoot}/key`);
    const data = readRecord(body, "OpenRouter key response").data;
    const key = readRecord(data, "OpenRouter key response.data");
    if (key.limit === null || key.limit_remaining === null) {
      throw new Error("OpenRouter resale key must have a finite spending limit");
    }
    const limit = parseUsdNumberFloor(key.limit, "OpenRouter key limit");
    const remaining = parseUsdNumberFloor(
      key.limit_remaining,
      "OpenRouter key limit_remaining",
    );
    const reset = key.limit_reset;
    if (reset !== null && typeof reset !== "string") {
      throw new Error("OpenRouter key limit_reset must be a string or null");
    }
    return { limit, remaining, reset };
  }

  private async readModelPricing(model: string): Promise<ProviderModelPricing> {
    const cached = this.pricingCache;
    const now = this.now();
    if (
      cached &&
      cached.model === model &&
      now - cached.fetchedAtMs < this.pricingCacheMs
    ) {
      return cached;
    }

    const body = await this.fetchJson(`${this.apiRoot}/models`);
    const root = readRecord(body, "OpenRouter models response");
    if (!Array.isArray(root.data)) {
      throw new Error("OpenRouter models response.data must be an array");
    }
    const rawModel = root.data.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as Record<string, unknown>).id === model,
    );
    if (!rawModel) throw new Error(`OpenRouter model not found: ${model}`);
    const modelRecord = rawModel as Record<string, unknown>;
    const pricing = readRecord(modelRecord.pricing, `OpenRouter pricing for ${model}`);
    const prompt = readPrice(pricing.prompt, `${model} prompt price`);
    const completion = readPrice(
      pricing.completion,
      `${model} completion price`,
    );
    const request = pricing.request === undefined
      ? 0n
      : readPrice(pricing.request, `${model} request price`);

    const result: ProviderModelPricing = {
      model,
      promptUsdNanosPerToken: prompt,
      completionUsdNanosPerToken: completion,
      requestUsdNanos: request,
      fetchedAtMs: now,
    };
    this.pricingCache = result;
    return result;
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, {
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      const text = await readBoundedBody(response, 8 * 1024 * 1024, controller);
      if (!response.ok) {
        throw new Error(
          `OpenRouter capacity request returned HTTP ${response.status}${
            text ? `: ${text.slice(0, 200)}` : ""
          }`,
        );
      }
      try {
        return JSON.parse(text);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`OpenRouter capacity response was not JSON: ${detail}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenRouter capacity request failed: ${detail}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      controller.abort();
      throw new Error(`OpenRouter capacity response exceeded ${maxBytes} bytes`);
    }
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join("");
}

function readRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function readPrice(value: unknown, label: string): bigint {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  try {
    return parseUsdDecimal(value, "ceil");
  } catch {
    throw new Error(`${label} must be a non-negative decimal`);
  }
}
