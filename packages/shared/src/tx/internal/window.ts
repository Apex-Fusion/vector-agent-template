/**
 * tx/internal/window.ts — validity windows of escrow transactions.
 *
 * A script sees the validity range as slot start times: `lo` is the start of
 * the slot in the validity interval start, `hi` the start of the TTL slot
 * (Cardano ledger: both bounds are slots). lucid converts a time to the slot
 * that contains it (`unixTimeToEnclosingSlot`), so the builders pass
 * slot-aligned times and know `lo` and `hi` exactly. The identity checks of
 * Claim and Submit run on these exact values.
 *
 * Part 2 §6.5: every escrow builder sets hi − lo ≤ 3,600,000 (MAX_RANGE_MS).
 * Part 2 §6.1 rule 3 makes the new escrow fail every other range.
 */

import { TxConstructionError } from "../types.js";
import { ACCEPT_WINDOW_MS, LOWER_BOUND_BACKPAD_MS, MAX_RANGE_MS } from "./constants.js";

export interface SlotClock {
  zeroTimeMs: number;
  slotLengthMs: number;
}

/** POSIX ms of a validity range, both slot starts. The script sees [lo, hi]. */
export interface ValidityWindow {
  lo: number;
  hi: number;
}

/** Vector testnet genesis; VECTOR_ZERO_TIME_MS overrides it (mainnet: 1_756_485_600_000). */
const DEFAULT_VECTOR_ZERO_TIME_MS = 1_752_057_484_000;

/** Upper bound of a Submit: 2 minutes for inclusion, capped at deliver_by. */
const SUBMIT_WINDOW_MS = 120_000;

/** Upper bound of a terminal spend and of an advert spend: 1 minute past the tip. */
const FORWARD_PAD_MS = 60_000;

/**
 * The Vector slot clock of the live builders: one slot per second from
 * VECTOR_ZERO_TIME_MS. lucidContext gives lucid's "Mainnet" slot config the
 * same values. Read at call time, so a CLI that loads .env late still gets
 * the right zero time.
 */
export function vectorSlotClock(): SlotClock {
  const env = typeof process === "undefined" ? undefined : process.env.VECTOR_ZERO_TIME_MS;
  return { zeroTimeMs: Number(env) || DEFAULT_VECTOR_ZERO_TIME_MS, slotLengthMs: 1000 };
}

/** The mock chain counts time as slot × 1000 ms. */
export const MOCK_SLOT_CLOCK: SlotClock = { zeroTimeMs: 0, slotLengthMs: 1000 };

/** Start of the slot that contains `ms`. */
export function slotFloor(ms: number, clock: SlotClock): number {
  return clock.zeroTimeMs + Math.floor((ms - clock.zeroTimeMs) / clock.slotLengthMs) * clock.slotLengthMs;
}

/** Start of the first slot at or after `ms`. */
export function slotCeil(ms: number, clock: SlotClock): number {
  return clock.zeroTimeMs + Math.ceil((ms - clock.zeroTimeMs) / clock.slotLengthMs) * clock.slotLengthMs;
}

/**
 * A window that the builder may use, or TxConstructionError `reason` when the
 * window cannot reach past the tip. Throws "validity range too long" when
 * hi − lo > MAX_RANGE_MS: no builder below can produce that, so it marks a bug.
 */
function usable(lo: number, hi: number, tipMs: number, reason: string): ValidityWindow {
  if (hi <= tipMs || hi <= lo) {
    throw new TxConstructionError(reason, `validity range [${lo}, ${hi}] does not reach past the tip ${tipMs}`);
  }
  if (hi - lo > MAX_RANGE_MS) {
    throw new TxConstructionError("validity range too long", `hi - lo = ${hi - lo} > ${MAX_RANGE_MS}`);
  }
  return { lo, hi };
}

/** Post: [posted_at − 60 s, min(deliver_by, lo + 1 h)]. */
export function postWindow(postedAt: number, deliverBy: number, clock: SlotClock): ValidityWindow {
  const lo = slotFloor(postedAt - LOWER_BOUND_BACKPAD_MS, clock);
  return usable(lo, slotFloor(Math.min(deliverBy, lo + MAX_RANGE_MS), clock), postedAt, "post after deliver_by");
}

/** Claim: [tip − 60 s, min(deliver_by, lo + 1 h)]. */
export function claimWindow(tipMs: number, deliverBy: number, clock: SlotClock): ValidityWindow {
  const lo = slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock);
  return usable(lo, slotFloor(Math.min(deliverBy, lo + MAX_RANGE_MS), clock), tipMs, "claim after deliver_by");
}

/** Submit: [tip − 60 s, min(tip + 2 min, deliver_by)]. The new datum stores submitted_at = hi. */
export function submitWindow(tipMs: number, deliverBy: number, clock: SlotClock): ValidityWindow {
  const lo = slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock);
  return usable(lo, slotFloor(Math.min(tipMs + SUBMIT_WINDOW_MS, deliverBy), clock), tipMs, "submit after deliver_by");
}

/** Accept: [max(tip − 60 s, hi − 1 h), submitted_at + 10 min]. */
export function acceptWindow(tipMs: number, submittedAt: number, clock: SlotClock): ValidityWindow {
  const hi = slotFloor(submittedAt + ACCEPT_WINDOW_MS, clock);
  const lo = Math.max(slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock), slotCeil(hi - MAX_RANGE_MS, clock));
  return usable(lo, hi, tipMs, "accept window expired");
}

/** Reclaim: [max(deliver_by, tip − 60 s), tip + 1 min]; no slot of it is before deliver_by. */
export function reclaimWindow(tipMs: number, deliverBy: number, clock: SlotClock): ValidityWindow {
  const lo = Math.max(slotCeil(deliverBy, clock), slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock));
  return usable(lo, slotFloor(tipMs + FORWARD_PAD_MS, clock), tipMs, "reclaim before deliver_by");
}

/** Release: [max(submitted_at + 10 min, tip − 60 s), tip + 1 min]. */
export function releaseWindow(tipMs: number, submittedAt: number, clock: SlotClock): ValidityWindow {
  const lo = Math.max(slotCeil(submittedAt + ACCEPT_WINDOW_MS, clock), slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock));
  return usable(lo, slotFloor(tipMs + FORWARD_PAD_MS, clock), tipMs, "release before accept window");
}

/** RefundRevoked and advert spends: [tip − 60 s, tip + 1 min]. */
export function nowWindow(tipMs: number, clock: SlotClock): ValidityWindow {
  const lo = slotFloor(tipMs - LOWER_BOUND_BACKPAD_MS, clock);
  return usable(lo, slotFloor(tipMs + FORWARD_PAD_MS, clock), tipMs, "validity range closed");
}
