/**
 * tx/internal/constants.ts — shared constants for M1-B tx builders.
 */

/** ACCEPT_WINDOW_MS — 10 minutes in ms (escrow.ak: accept_window_ms). */
export const ACCEPT_WINDOW_MS = 600_000;

/** Buyer-side network-buffer added to deliver_by computation. ARCHITECTURE.md §4.3. */
export const NETWORK_BUFFER_MS = 30_000;

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
