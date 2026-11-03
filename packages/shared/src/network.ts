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
 * These are the Vector genesis values of the shared package. The slot clocks
 * of the transaction builders derive from them: VECTOR_MAINNET_SLOT_CONFIG
 * (identity/tx) and the testnet default of tx/internal/window.ts.
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
 * Vector mainnet parameters (Part 1 §4): system start 2025-08-29T16:40:00Z,
 * one slot per second. The Koios genesis of Vector mainnet
 * (https://v2.koios.vector.mainnet.apexfusion.org/api/v1/genesis) gives
 * `systemstart` 1756485600 and `slotlength` 1.
 */
export const VECTOR_MAINNET: NetworkParams = {
  networkId: 1,
  systemStartUnix: 1756485600,
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
