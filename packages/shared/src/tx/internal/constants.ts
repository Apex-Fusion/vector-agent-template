/**
 * tx/internal/constants.ts — shared constants for M1-B tx builders.
 */

import { MAX_ESCROW_LOVELACE, MAX_RANGE_MS } from "../../identity/constants.js";

/** ACCEPT_WINDOW_MS — 10 minutes in ms (escrow.ak: accept_window_ms). */
export const ACCEPT_WINDOW_MS = 600_000;

/** Buyer-side network-buffer added to deliver_by computation. ARCHITECTURE.md §4.3. */
export const NETWORK_BUFFER_MS = 30_000;

/** Longest validity range (hi − lo) of every escrow transaction: one hour (Part 2 §6.5). */
export { MAX_RANGE_MS };

/** Largest payment + buyer bond + supplier bond of an escrow (Part 2 §6.5, F-29): 10,000 AP3X. */
export const ESCROW_VALUE_CAP_LOVELACE = MAX_ESCROW_LOVELACE;

/** Most AP3X that the escrow input may hold for a Claim (Part 2 §6.1): 10,005 AP3X. */
export const ESCROW_INPUT_CAP_LOVELACE = 10_005_000_000n;

/** Back-pad of a lower validity bound, so a builder clock that runs ahead of the node does not make the tx early. */
export const LOWER_BOUND_BACKPAD_MS = 60_000;

/** Floor of every payout and script output that the live builders write (2 AP3X). */
export const MIN_UTXO_LOVELACE = 2_000_000n;

/** Default testnet script-address prefix (used by sample fixture). */
export const ESCROW_SCRIPT_ADDRESS_TESTNET =
  "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

export const ADVERT_SCRIPT_ADDRESS_TESTNET =
  "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6";

/** Slot-to-wallclock convention: MockChainProvider tests use slot * 1000 ≈ POSIX ms. */
export function mockSlotToWallclockMs(slot: number): number {
  return slot * 1000;
}

/** Inverse: wallclock ms → mock slot. */
export function mockWallclockMsToSlot(ms: number): number {
  return Math.floor(ms / 1000);
}
