/**
 * Network parameters for slot/wallclock conversion.
 *
 * ChainProvider.tip() stays slot-only. This module provides the conversion
 * helpers tx-builders use when they need to compute POSIX-time-based validity
 * ranges from a slot tip (or vice versa).
 *
 * Vector L2 inherits Cardano slot semantics: 1 slot = 1 second on Vector
 * chains, so `slotLengthMs = 1000`.
 *
 * For mainnet, `systemStartUnix` is intentionally NaN so any caller who
 * accidentally targets mainnet without supplying real params fails loudly.
 * TODO M3+: fill in mainnet systemStartUnix once the network is live.
 */

export type NetworkId = 0 | 1; // 0 = testnet, 1 = mainnet

export interface NetworkParams {
  networkId: NetworkId;
  /** POSIX seconds at which slot 0 began. */
  systemStartUnix: number;
  /** Slot length in milliseconds. */
  slotLengthMs: number;
}

/**
 * Vector testnet parameters.
 *
 * systemStartUnix is the testnet genesis (2025-07-09T11:18:04Z, approx).
 * 1 slot = 1 second, matching Cardano's testnet conventions.
 */
export const VECTOR_TESTNET: NetworkParams = {
  networkId: 0,
  systemStartUnix: 1752057484,
  slotLengthMs: 1000,
};

/**
 * Vector mainnet parameters.
 * TODO M3+: replace `systemStartUnix` placeholder with the real genesis time.
 * Currently NaN so any caller that targets mainnet without supplying real
 * params will produce NaN slots — a loud failure rather than silent garbage.
 */
export const VECTOR_MAINNET: NetworkParams = {
  networkId: 1,
  systemStartUnix: Number.NaN,
  slotLengthMs: 1000,
};

/** Convert a slot number to POSIX milliseconds. */
export function slotToPosixMs(slot: number, p: NetworkParams): number {
  return (p.systemStartUnix + slot) * 1000;
}

/** Convert POSIX milliseconds to a slot number (floored). */
export function posixMsToSlot(ms: number, p: NetworkParams): number {
  return Math.floor(ms / 1000) - p.systemStartUnix;
}
