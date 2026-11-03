export interface ProviderModelPricing {
  model: string;
  promptUsdNanosPerToken: bigint;
  completionUsdNanosPerToken: bigint;
  requestUsdNanos: bigint;
  fetchedAtMs: number;
}

export interface ProviderCapacityReading {
  provider: string;
  keyLimitUsdNanos: bigint;
  keyRemainingUsdNanos: bigint;
  limitReset: string | null;
  pricing: ProviderModelPricing;
  checkedAtMs: number;
}

/** Provider-specific balance and price discovery. Inference stays OpenAI-compatible. */
export interface CapacityProvider {
  readonly id: string;
  readCapacity(model: string): Promise<ProviderCapacityReading>;
}
