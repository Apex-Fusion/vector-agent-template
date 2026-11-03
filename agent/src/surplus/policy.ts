export interface SurplusCompetitor {
  id: string;
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
}

export interface SurplusMultiplierPolicyInput {
  upstreamInputMicroUsdPer1m: number;
  upstreamOutputMicroUsdPer1m: number;
  recoveryBps: number;
  undercutBps: number;
  competitors: SurplusCompetitor[];
}

export interface SurplusMultiplierQuote {
  costMultiplierPpm: number;
  costMultiplier: number;
  inputMicroUsdPer1m: number;
  outputMicroUsdPer1m: number;
  floorMultiplierPpm: number;
  competitorId: string | null;
  competitive: boolean;
}

const BPS_SCALE = 10_000n;
const PPM_SCALE = 1_000_000n;
const MICRO_USD = 1_000_000;

export function quoteSurplusMultiplier(
  input: SurplusMultiplierPolicyInput,
): SurplusMultiplierQuote {
  positiveSafeInteger(
    input.upstreamInputMicroUsdPer1m,
    "upstream input price",
  );
  positiveSafeInteger(
    input.upstreamOutputMicroUsdPer1m,
    "upstream output price",
  );
  boundedBps(input.recoveryBps, "recoveryBps", 1, 10_000);
  boundedBps(input.undercutBps, "undercutBps", 0, 9_999);

  const floorMultiplierPpm = input.recoveryBps * 100;
  const competitor = cheapestCompetitor(input.competitors);
  const competitorMultiplierPpm = competitor
    ? Math.min(
        ratioPpm(
          competitor.inputMicroUsdPer1m,
          input.upstreamInputMicroUsdPer1m,
        ),
        ratioPpm(
          competitor.outputMicroUsdPer1m,
          input.upstreamOutputMicroUsdPer1m,
        ),
      )
    : floorMultiplierPpm;
  let undercutMultiplierPpm = Number(
    BigInt(competitorMultiplierPpm) *
      BigInt(10_000 - input.undercutBps) /
      BPS_SCALE,
  );
  if (
    input.undercutBps > 0 &&
    undercutMultiplierPpm >= competitorMultiplierPpm
  ) {
    undercutMultiplierPpm = Math.max(1, competitorMultiplierPpm - 1);
  }
  const quotedMultiplierPpm = Math.max(
    floorMultiplierPpm,
    undercutMultiplierPpm,
  );
  const quotedInput = applyMultiplier(
    input.upstreamInputMicroUsdPer1m,
    quotedMultiplierPpm,
  );
  const quotedOutput = applyMultiplier(
    input.upstreamOutputMicroUsdPer1m,
    quotedMultiplierPpm,
  );

  return {
    costMultiplierPpm: quotedMultiplierPpm,
    costMultiplier: quotedMultiplierPpm / Number(PPM_SCALE),
    inputMicroUsdPer1m: quotedInput,
    outputMicroUsdPer1m: quotedOutput,
    floorMultiplierPpm,
    competitorId: competitor?.id ?? null,
    competitive: competitor === null || (
      quotedInput < competitor.inputMicroUsdPer1m &&
      quotedOutput < competitor.outputMicroUsdPer1m
    ),
  };
}

export function usdPer1mToMicroUsd(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
  const result = Math.ceil(value * MICRO_USD);
  positiveSafeInteger(result, field);
  return result;
}

export function formatMicroUsd(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("micro-USD value must be a non-negative safe integer");
  }
  const whole = Math.floor(value / MICRO_USD);
  const fraction = (value % MICRO_USD).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function cheapestCompetitor(
  competitors: SurplusCompetitor[],
): SurplusCompetitor | null {
  let result: SurplusCompetitor | null = null;
  for (const competitor of competitors) {
    positiveSafeInteger(competitor.inputMicroUsdPer1m, "competitor input price");
    positiveSafeInteger(competitor.outputMicroUsdPer1m, "competitor output price");
    if (result === null || compareCompetitors(competitor, result) < 0) {
      result = competitor;
    }
  }
  return result;
}

function compareCompetitors(
  left: SurplusCompetitor,
  right: SurplusCompetitor,
): number {
  return (
    left.inputMicroUsdPer1m + left.outputMicroUsdPer1m -
      (right.inputMicroUsdPer1m + right.outputMicroUsdPer1m) ||
    left.inputMicroUsdPer1m - right.inputMicroUsdPer1m ||
    left.outputMicroUsdPer1m - right.outputMicroUsdPer1m ||
    left.id.localeCompare(right.id)
  );
}

function ratioPpm(numerator: number, denominator: number): number {
  return Number(BigInt(numerator) * PPM_SCALE / BigInt(denominator));
}

function applyMultiplier(value: number, multiplierPpm: number): number {
  return Number(BigInt(value) * BigInt(multiplierPpm) / PPM_SCALE);
}

function positiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
}

function boundedBps(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be from ${minimum} to ${maximum}`);
  }
}
