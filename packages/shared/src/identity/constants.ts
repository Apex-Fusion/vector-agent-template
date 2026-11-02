/**
 * Constants of the identity registry (Part 1 §5, Part 2 §2–§6). They equal
 * the constants of the Aiken library `vector_identity`.
 */

import type { Role } from "../cbor/IdentityDatum.js";

// ─── Key purposes (Part 1 §5) ────────────────────────────────────────

export const PURPOSE_AUTHENTICATION = 1;
export const PURPOSE_ASSERTION = 2;
export const PURPOSE_TRANSACTION = 8;
export const PURPOSE_DELEGATION = 16;
/** Purpose bits that an Ed25519 key can have: 1 + 2 + 8 + 16. */
export const ED25519_PURPOSES = 27;
/** Purpose bits that a P-256 key can have: 1 + 2. */
export const P256_PURPOSES = 3;

// ─── Party rights (Part 1 §5) ────────────────────────────────────────

export const RIGHT_SUSPEND = 1;
export const RIGHT_REVOKE = 2;
export const RIGHT_RECOVER = 4;
/** The highest rights of each role. */
export const ROLE_MAX_RIGHTS: Readonly<Record<Role, number>> = {
  Accountable: RIGHT_SUSPEND | RIGHT_REVOKE,
  Responsible: RIGHT_SUSPEND,
  Provider: RIGHT_SUSPEND,
  Distributor: 0,
  Guardian: RIGHT_RECOVER,
};

// ─── Time ────────────────────────────────────────────────────────────

/** Largest validity range of an identity, attestation, delegation, vault or escrow transaction. */
export const MAX_RANGE_MS = 3_600_000;
/** Last millisecond of the year 9999. Every record time is in [0, MAX_TIME_MS]. */
export const MAX_TIME_MS = 253_402_300_799_999;
/** Every other record integer is in [0, 2^63). */
export const MAX_RECORD_INT = (1n << 63n) - 1n;
export const DAY_MS = 86_400_000;
export const DAYS_7_MS = 7 * DAY_MS;
export const DAYS_30_MS = 30 * DAY_MS;
export const DAYS_90_MS = 90 * DAY_MS;
export const DAYS_366_MS = 366 * DAY_MS;

// ─── Record limits (Part 1 §5) ───────────────────────────────────────

/** Largest subagent depth, and largest delegation depth + remaining. */
export const MAX_DEPTH = 4;
export const MAX_KEYS = 8;
export const MAX_PARTIES = 8;
export const MAX_HOLDS = 10;
export const NAME_MAX_BYTES = 64;
export const DESCRIPTION_MAX_BYTES = 256;
export const FRAMEWORK_MAX_BYTES = 64;
export const ENDPOINT_MAX_BYTES = 256;
export const MAX_CAPABILITIES = 16;
export const CAPABILITY_MAX_BYTES = 64;
export const ORGANISATION_MAX_BYTES = 64;

// ─── Attestation and delegation limits (Part 2 §4, §5.2) ─────────────

export const MAX_LINKS = 4;
export const LOCATOR_MAX_BYTES = 256;
export const ANCHOR_URI_MAX_BYTES = 256;
export const MAX_ACTIONS = 16;
export const MAX_RESOURCES = 8;

// ─── Amounts in lovelace (1 AP3X = 1,000,000) ────────────────────────

/** Smallest AP3X amount of a live identity record (10 AP3X). */
export const MIN_RECORD_LOVELACE = 10_000_000n;
/** Smallest AP3X amount of an attestation output (5 AP3X). */
export const MIN_ATTESTATION_LOVELACE = 5_000_000n;
/** Largest payment + buyer bond + supplier bond of an escrow, and largest delegation value limit (10,000 AP3X). */
export const MAX_ESCROW_LOVELACE = 10_000_000_000n;
