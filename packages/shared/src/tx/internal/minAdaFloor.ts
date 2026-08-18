/**
 * minAdaFloor.ts — min-ada floor for the escrow's LARGEST future datum.
 *
 * The escrow validator requires value_equal(continuing, in) on Claim and
 * Submit, so the lovelace locked at POST time must already satisfy min-ada
 * for every datum the output will ever carry. The largest is the Submitted
 * state: submitted_at None -> Some(POSIX ms) and result_receipt_hash
 * None -> Some(32 bytes) add ~43 bytes over Open/Claimed. If the posted
 * lovelace sits below that state's min-ada, lucid bumps the Submit
 * continuing output to min-ada, value_equal fails, and the validator
 * errors with no traces (the 2026-08-07 mainnet incident: the 33-byte
 * "ocr.page.extract.chandra-ocr-2.v1" capability_id pushed the Submitted
 * output 11,030 lovelace over a 2,200,000 lock; the 20-byte chat
 * capability stayed 49,310 under, which is why only OCR Submits failed).
 *
 * escrowLockFloor() returns the lovelace to lock: the economic total
 * (payment + both bonds), raised to the Submitted-state min-ada plus a
 * safety margin when the total alone is too small.
 */

import type { EscrowDatum } from "../../cbor/types.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";

/** Conway/Babbage utxoCostPerByte on Vector mainnet (protocol params). */
const UTXO_COST_PER_BYTE = 4310n;

/** Ledger constant: min-ada = (160 + serialized output bytes) * costPerByte. */
const OUTPUT_OVERHEAD_BYTES = 160n;

/** Covers CBOR framing drift between this estimate and the ledger's exact
 * serialization (address, coin width, datum wrapper). Generous on purpose:
 * 50k lovelace = 0.05 AP3X, dwarfed by per-leg tx fees. */
const SAFETY_MARGIN_LOVELACE = 50_000n;

/** Serialized-output byte estimate for an enterprise script address output
 * carrying `lovelace` and an inline datum of `datumBytes`. Mirrors the
 * arithmetic validated against mainnet on 2026-08-07 (minada-calc). */
function estimateOutputBytes(datumBytes: number, lovelace: bigint): bigint {
  const addr = 1n + 29n;
  const coin = 1n + (lovelace > 0xffffffffn ? 8n : 4n);
  const datumField = 1n + 2n + 3n + BigInt(datumBytes);
  const mapOverhead = 3n;
  return addr + coin + datumField + mapOverhead;
}

/** Min-ada for the escrow output when it carries `datum`. */
export function minAdaForEscrowDatum(datum: EscrowDatum, lovelace: bigint): bigint {
  const datumBytes = encodeEscrowDatum(datum).length / 2;
  const size = estimateOutputBytes(datumBytes, lovelace);
  return (OUTPUT_OVERHEAD_BYTES + size) * UTXO_COST_PER_BYTE;
}

/** The lovelace a POST must lock so the escrow output satisfies min-ada in
 * every reachable state, including Submitted. `economicTotal` is
 * payment + buyer_bond + supplier_bond. */
export function escrowLockFloor(openDatum: EscrowDatum, economicTotal: bigint): bigint {
  const submittedShape: EscrowDatum = {
    ...openDatum,
    // Representative worst-case Submit fields: a 13-digit POSIX ms stamp
    // and a 32-byte receipt hash — sizes, not values, matter here.
    submitted_at: openDatum.deliver_by,
    result_receipt_hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    state: "Submitted",
  };
  const floor = minAdaForEscrowDatum(submittedShape, economicTotal) + SAFETY_MARGIN_LOVELACE;
  return floor > economicTotal ? floor : economicTotal;
}
