export const USD_NANOS = 1_000_000_000n;

export type DecimalRounding = "floor" | "ceil";

/** Parse a non-negative decimal USD string into integer nanodollars. */
export function parseUsdDecimal(
  raw: string,
  rounding: DecimalRounding,
): bigint {
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new Error(`invalid USD decimal: ${raw}`);

  const dot = raw.indexOf(".");
  const wholeRaw = dot === -1 ? raw : raw.slice(0, dot);
  const fractionRaw = dot === -1 ? "" : raw.slice(dot + 1);
  const kept = fractionRaw.slice(0, 9).padEnd(9, "0");
  let nanos = BigInt(wholeRaw) * USD_NANOS + BigInt(kept || "0");
  if (rounding === "ceil" && /[1-9]/.test(fractionRaw.slice(9))) {
    nanos += 1n;
  }
  return nanos;
}

/**
 * Convert a provider JSON number to a conservative remaining-balance value.
 * One nanodollar is removed to protect against binary floating-point rounding.
 */
export function parseUsdNumberFloor(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  const scaled = BigInt(Math.floor(value * Number(USD_NANOS)));
  return scaled > 0n ? scaled - 1n : 0n;
}

/** Convert a provider JSON cost to nanodollars without rounding down. */
export function parseUsdNumberCeil(value: unknown, field: string): bigint {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  if (value === 0) return 0n;
  return BigInt(Math.ceil(value * Number(USD_NANOS))) + 1n;
}

export function formatUsdNanos(value: bigint, decimals = 6): string {
  if (value < 0n) throw new Error("USD value must be non-negative");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    throw new Error("USD display decimals must be from 0 to 9");
  }
  const whole = value / USD_NANOS;
  if (decimals === 0) return whole.toString();
  const fraction = (value % USD_NANOS).toString().padStart(9, "0");
  return `${whole}.${fraction.slice(0, decimals)}`;
}
