/**
 * receipt/fields.ts — the receipt field lists (Part 2 §6.3).
 *
 * This module has no runtime imports, so a browser bundle can import it
 * (`@marketplace/shared/receipt-fields`). The rest of the receipt module
 * (`@marketplace/shared/receipt`) imports Node crypto for signing and hashing.
 */

import type { Receipt } from "./build.js";

/** The 8 fields of a receipt for a legacy escrow. */
export const RECEIPT_FIELDS = [
  "prompt_hash", "response_hash", "model", "prompt_tokens", "completion_tokens", "wallclock_ms", "supplier_pkh", "escrow_ref",
] as const satisfies readonly (keyof Receipt)[];

/** The 9 fields of a receipt for a new escrow: the 8 fields and agent_did. */
export const AGENT_RECEIPT_FIELDS = [...RECEIPT_FIELDS, "agent_did"] as const satisfies readonly (keyof Receipt)[];
