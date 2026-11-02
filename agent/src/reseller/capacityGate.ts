import type { CapacityProvider } from "./provider.js";
import { parseUsdDecimal } from "./money.js";

export type CapacityReason =
  | "starting"
  | "ready"
  | "below_reserve"
  | "insufficient_for_job"
  | "provider_unavailable"
  | "database_unavailable"
  | "stale";

export interface CapacitySnapshot {
  provider: string;
  model: string;
  canServe: boolean;
  reason: CapacityReason;
  checkedAtMs: number | null;
  lastSuccessAtMs: number | null;
  keyLimitUsdNanos: bigint;
  remainingAllowanceUsdNanos: bigint;
  reserveUsdNanos: bigint;
  sellableUsdNanos: bigint;
  worstCaseJobUsdNanos: bigint;
  promptPriceUsdNanosPerToken: bigint;
  completionPriceUsdNanosPerToken: bigint;
  requestPriceUsdNanos: bigint;
  availableJobs: bigint | null;
  limitReset: string | null;
  error: string | null;
}

interface CapacityGateOptions {
  provider: CapacityProvider;
  model: string;
  reserveUsd: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  staleAfterMs: number;
  now?: () => number;
}

export class CapacityGate {
  private readonly provider: CapacityProvider;
  private readonly model: string;
  private readonly reserveUsdNanos: bigint;
  private readonly maxInputTokens: number;
  private readonly maxOutputTokens: number;
  private readonly staleAfterMs: number;
  private readonly now: () => number;
  private current: CapacitySnapshot;
  private inFlight: Promise<CapacitySnapshot> | null = null;

  constructor(options: CapacityGateOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.reserveUsdNanos = parseUsdDecimal(options.reserveUsd, "ceil");
    this.maxInputTokens = options.maxInputTokens;
    this.maxOutputTokens = options.maxOutputTokens;
    this.staleAfterMs = options.staleAfterMs;
    this.now = options.now ?? Date.now;
    this.current = {
      provider: options.provider.id,
      model: options.model,
      canServe: false,
      reason: "starting",
      checkedAtMs: null,
      lastSuccessAtMs: null,
      keyLimitUsdNanos: 0n,
      remainingAllowanceUsdNanos: 0n,
      reserveUsdNanos: this.reserveUsdNanos,
      sellableUsdNanos: 0n,
      worstCaseJobUsdNanos: 0n,
      promptPriceUsdNanosPerToken: 0n,
      completionPriceUsdNanosPerToken: 0n,
      requestPriceUsdNanos: 0n,
      availableJobs: 0n,
      limitReset: null,
      error: null,
    };
  }

  snapshot(): CapacitySnapshot {
    const snapshot = this.current;
    if (
      snapshot.lastSuccessAtMs !== null &&
      this.now() - snapshot.lastSuccessAtMs > this.staleAfterMs
    ) {
      return {
        ...snapshot,
        canServe: false,
        reason: "stale",
        error: "provider capacity data is stale",
      };
    }
    return { ...snapshot };
  }

  async refresh(): Promise<CapacitySnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.performRefresh();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  forceUnavailable(
    reason: Extract<CapacityReason, "database_unavailable" | "provider_unavailable">,
    error: string,
  ): CapacitySnapshot {
    this.current = {
      ...this.current,
      canServe: false,
      reason,
      checkedAtMs: this.now(),
      error,
    };
    return this.snapshot();
  }

  private async performRefresh(): Promise<CapacitySnapshot> {
    try {
      const reading = await this.provider.readCapacity(this.model);
      const pricing = reading.pricing;
      const worstCaseJobUsdNanos =
        pricing.requestUsdNanos +
        pricing.promptUsdNanosPerToken * BigInt(this.maxInputTokens) +
        pricing.completionUsdNanosPerToken * BigInt(this.maxOutputTokens);
      const remaining = reading.keyRemainingUsdNanos;
      const sellable = remaining > this.reserveUsdNanos
        ? remaining - this.reserveUsdNanos
        : 0n;
      const enoughForOne =
        worstCaseJobUsdNanos === 0n || sellable >= worstCaseJobUsdNanos;
      const aboveReserve = remaining >= this.reserveUsdNanos;
      const canServe = aboveReserve && enoughForOne;
      const reason: CapacityReason = canServe
        ? "ready"
        : !aboveReserve
          ? "below_reserve"
          : "insufficient_for_job";
      const availableJobs = worstCaseJobUsdNanos === 0n
        ? null
        : sellable / worstCaseJobUsdNanos;

      this.current = {
        provider: reading.provider,
        model: this.model,
        canServe,
        reason,
        checkedAtMs: reading.checkedAtMs,
        lastSuccessAtMs: reading.checkedAtMs,
        keyLimitUsdNanos: reading.keyLimitUsdNanos,
        remainingAllowanceUsdNanos: remaining,
        reserveUsdNanos: this.reserveUsdNanos,
        sellableUsdNanos: sellable,
        worstCaseJobUsdNanos,
        promptPriceUsdNanosPerToken: pricing.promptUsdNanosPerToken,
        completionPriceUsdNanosPerToken: pricing.completionUsdNanosPerToken,
        requestPriceUsdNanos: pricing.requestUsdNanos,
        availableJobs,
        limitReset: reading.limitReset,
        error: null,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.current = {
        ...this.current,
        canServe: false,
        reason: "provider_unavailable",
        checkedAtMs: this.now(),
        error: detail,
      };
    }
    return this.snapshot();
  }
}
