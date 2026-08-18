/**
 * planConsolidate.ts — pure pre-flight planner for the wallet-consolidate flow.
 *
 * Given a wallet's current UTxO set + a target collateral lovelace, decide
 * whether the wallet needs reshaping or is already usable for script spends.
 *
 * Healthy is a STRUCTURAL predicate, not a UTxO count (F7, 2026-08-08):
 *   (a) some pure-lovelace UTxO >= collateralLovelace exists (the collateral
 *       candidate lucid's setCollateral needs), AND
 *   (b) at least MIN_WORKING_LOVELACE sits OUTSIDE that candidate (fee and
 *       spend money that is not the candidate), AND
 *   (c) fragmentation is bounded (utxos.length <= maxUtxos).
 *
 * The earlier revision returned `already-healthy` only for EXACTLY 2 UTxOs.
 * The consolidate tx itself lands 3 (collateral + working + the fee-reserve
 * remainder as change), so the shape consolidation produced could never
 * satisfy its own health check — the wallet-health ticker re-consolidated
 * every tick and burned 0.5 AP3X per pass (116 AP3X in one 24h soak).
 * The health check also runs BEFORE the low-balance guard now: a wallet that
 * can already transact must never be told "balance too low to consolidate".
 *
 * No lucid / WASM deps so this is unit-testable from a vanilla vitest.
 */

export interface UtxoLike {
  assets: { lovelace?: bigint } & Record<string, bigint | undefined>;
}

export type ConsolidateReason = "consolidate" | "split" | "already-healthy";

export interface PlannedConsolidate {
  inputCount: number;
  totalLovelaceIn: bigint;
  collateralOutput: bigint;
  workingOutput: bigint;
  alreadyHealthy: boolean;
  reason: ConsolidateReason;
}

export const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;
export const DEFAULT_FEE_RESERVE = 2_000_000n;
/** Reshape only when fragmentation passes this; receipt/change UTxOs
 *  accumulating between jobs are fine as long as a candidate exists. */
export const DEFAULT_MAX_UTXOS = 6;
const MIN_WORKING_LOVELACE = 1_000_000n;

/** Lovelace of a UTxO iff it carries no native assets; null otherwise. */
function pureLovelace(u: UtxoLike): bigint | null {
  for (const [unit, amount] of Object.entries(u.assets)) {
    if (unit !== "lovelace" && (amount ?? 0n) > 0n) return null;
  }
  return u.assets.lovelace ?? 0n;
}

export function planConsolidate(
  utxos: UtxoLike[],
  collateralLovelace: bigint = DEFAULT_COLLATERAL_LOVELACE,
  feeReserve: bigint = DEFAULT_FEE_RESERVE,
  maxUtxos: number = DEFAULT_MAX_UTXOS,
): PlannedConsolidate {
  if (utxos.length === 0) {
    throw new Error("wallet has no UTxOs — fund the address first");
  }

  const totalLovelaceIn = utxos.reduce(
    (acc, u) => acc + (u.assets.lovelace ?? 0n),
    0n,
  );

  // Structural health check first — reshaping a usable wallet wastes a fee.
  if (utxos.length <= maxUtxos) {
    // Smallest qualifying candidate: leave larger UTxOs as working funds.
    let candidate: bigint | null = null;
    for (const u of utxos) {
      const pure = pureLovelace(u);
      if (pure !== null && pure >= collateralLovelace) {
        if (candidate === null || pure < candidate) candidate = pure;
      }
    }
    if (candidate !== null) {
      const workingOutside = totalLovelaceIn - candidate;
      if (workingOutside >= MIN_WORKING_LOVELACE) {
        return {
          inputCount: utxos.length,
          totalLovelaceIn,
          collateralOutput: candidate,
          workingOutput: workingOutside,
          alreadyHealthy: true,
          reason: "already-healthy",
        };
      }
    }
  }

  // Reshape needed — only an actual reshape has a funds threshold.
  const required = collateralLovelace + feeReserve + MIN_WORKING_LOVELACE;
  if (totalLovelaceIn < required) {
    throw new Error(
      `balance too low to consolidate: have ${totalLovelaceIn} lovelace, ` +
        `need at least ${required} (= ${collateralLovelace} collateral + ` +
        `${feeReserve} fee reserve + ${MIN_WORKING_LOVELACE} min working)`,
    );
  }

  const workingOutput = totalLovelaceIn - collateralLovelace - feeReserve;

  return {
    inputCount: utxos.length,
    totalLovelaceIn,
    collateralOutput: collateralLovelace,
    workingOutput,
    alreadyHealthy: false,
    reason: utxos.length === 1 ? "split" : "consolidate",
  };
}
