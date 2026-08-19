/**
 * try-it/src/verify-receipt.ts — offline verification of a signed receipt.
 *
 * Three questions, answered without asking anybody:
 *   1. does the receipt commit the bytes I sent?      prompt_hash   === sha256(utf8(payload))
 *   2. does it commit the bytes I got back?           response_hash === sha256(utf8(output))
 *   3. did the supplier whose key I read from
 *      GET /capability actually sign it?              ed25519 over canonical(receipt)
 *
 * No network, no chain, no trust in the agent that served the response.
 *
 * `verifyChainBindings` (below) answers the fourth question — is this the
 * receipt the CHAIN commits, from the supplier the buyer paid? — and both must
 * pass before Accept.
 *
 * SIGNATURE-LAYOUT MIRROR — the load-bearing detail. The supplier signs
 * `ed25519(utf8(canonicalize(receipt)), privKey)` (packages/shared/src/receipt/sign.ts),
 * where `canonicalize` is the RFC-8785 JCS subset in
 * packages/shared/src/cbor/canonical.ts (sorted keys, NFC strings, no
 * whitespace). Rather than re-implement that serialisation here - a
 * re-implementation drifts silently the moment upstream changes a rule, and
 * the failure mode is a buyer that pays for unverifiable work - we call the
 * vendored verifier itself. Mirror by reuse, not by copy. `verify-receipt.test.ts`
 * proves the mirror end-to-end: every fixture is built and signed by the real
 * vendored `buildReceipt`/`signReceipt`, and a one-byte edit to a signed field
 * flips the verdict.
 *
 * The hash checks (1 and 2) are ours, because they are the buyer's half of the
 * custom-capability wire contract: raw sha256 over the exact UTF-8 bytes, no
 * canonicalisation, no wrapping - matching agent/src/routes/custom.ts (prompt)
 * and agent/src/customJobRunner.ts (response).
 */

import { createHash } from "crypto";
import { blake2b } from "@noble/hashes/blake2b";
import {
  verifyReceipt as verifyVendoredSignature,
  receiptResultHash,
} from "@marketplace/shared/receipt";
import type { Receipt, SignedReceipt } from "@marketplace/shared/receipt";

/**
 * A receipt as it arrives from `GET /v1/job/:jobId`: `receipt` is plain JSON
 * (field types unverified) and `receipt_signature` is a hex string. Accepting
 * `unknown` here is deliberate - the whole point is that we validate the
 * remote's shape rather than trusting the type declaration.
 */
export interface SignedReceiptLike {
  receipt: unknown;
  signature: unknown;
}

export interface VerifyResult {
  ok: boolean;
  /** Machine-readable failure code. Absent when ok. */
  reason?: string;
}

const HEX64_RE = /^[0-9a-f]{64}$/i;
const HEX128_RE = /^[0-9a-f]{128}$/i;

function sha256Utf8Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * verifyReceipt — the buyer's whole trust decision, offline.
 *
 * @param signed             `{ receipt, signature }` as served by the agent.
 * @param payload            the exact payload string the buyer POSTed.
 * @param output             the exact output string the agent returned.
 * @param supplierPubKeyHex  32-byte hex ed25519 key from `GET /capability`.
 *
 * Never throws. Every rejection carries a distinct `reason` so the caller can
 * print one line and exit.
 */
export function verifyReceipt(
  signed: SignedReceiptLike,
  payload: string,
  output: string,
  supplierPubKeyHex: string,
): VerifyResult {
  if (!signed || typeof signed !== "object") {
    return { ok: false, reason: "malformed_receipt" };
  }
  const receipt = signed.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return { ok: false, reason: "malformed_receipt" };
  }
  const fields = receipt as Record<string, unknown>;
  if (typeof fields.prompt_hash !== "string" || typeof fields.response_hash !== "string") {
    return { ok: false, reason: "malformed_receipt" };
  }
  if (!HEX64_RE.test(fields.prompt_hash) || !HEX64_RE.test(fields.response_hash)) {
    return { ok: false, reason: "malformed_receipt" };
  }
  if (typeof signed.signature !== "string" || !HEX128_RE.test(signed.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }
  if (typeof supplierPubKeyHex !== "string" || !HEX64_RE.test(supplierPubKeyHex)) {
    return { ok: false, reason: "malformed_pub_key" };
  }
  if (typeof payload !== "string" || typeof output !== "string") {
    return { ok: false, reason: "malformed_job_bytes" };
  }

  // 1. The receipt must commit the request bytes this buyer actually sent.
  if (fields.prompt_hash.toLowerCase() !== sha256Utf8Hex(payload)) {
    return { ok: false, reason: "prompt_hash_mismatch" };
  }
  // 2. ...and the response bytes this buyer actually received.
  if (fields.response_hash.toLowerCase() !== sha256Utf8Hex(output)) {
    return { ok: false, reason: "response_hash_mismatch" };
  }

  // 3. ...and be signed by the advertised supplier key, over the vendored
  //    canonical serialisation (see the mirror note in the file header).
  const vendored: SignedReceipt = {
    receipt: receipt as Receipt,
    signature: signed.signature,
  };
  if (!verifyVendoredSignature(vendored, supplierPubKeyHex)) {
    return { ok: false, reason: "signature_invalid" };
  }

  return { ok: true };
}

/**
 * What `verifyReceipt` alone cannot answer: is this the receipt the CHAIN
 * commits, from the supplier the buyer actually paid?
 *
 * Everything in `verifyReceipt` arrives over one HTTP connection — the receipt,
 * the output, and (from `GET /capability`) the key that signs it. A dishonest
 * endpoint can serve a self-consistent set of all three. These four checks
 * break that circularity by anchoring each piece to something the endpoint does
 * not control:
 *
 *   - `escrow_ref`   — the escrow THIS buyer posted, not some other job's receipt
 *   - `supplier_pkh` — the identity in the advert datum the buyer paid against
 *   - the key itself — blake2b-224(pub_key_hex) must equal that same advert
 *                      pkh, so a swapped signing key cannot pass by simply
 *                      being served alongside a matching signature
 *   - the receipt hash — `receiptResultHash({receipt, signature})` must equal
 *                      the `result_receipt_hash` the supplier wrote on chain in
 *                      its Submit tx. This is the binding: the bytes verified
 *                      off-chain are the bytes the chain records.
 *
 * `receiptResultHash` is the vendored helper the supplier's Submit path uses
 * (`customJobRunner.ts` → `buildSubmitTx({receiptHash})`), so this recomputes
 * the same value the same way rather than mirroring it.
 *
 * Reason strings follow the upstream buyer SDK where it has equivalents
 * (`wrong_supplier`, `wrong_escrow_ref` — buyer/src/sdk/Marketplace.ts).
 */
export interface ChainBindings {
  /** `result_receipt_hash` read from the Submitted-state escrow datum. */
  resultReceiptHashOnChain: string | null;
  /** `"<txHash>#<index>"` of the escrow this buyer posted. */
  escrowRefPosted: string;
  /** `supplier_pkh` from the advert datum the escrow was posted against. */
  advertSupplierPkh: string;
  /** `pub_key_hex` served by `GET /capability`. */
  supplierPubKeyHex: string;
}

export function verifyChainBindings(signed: SignedReceiptLike, bindings: ChainBindings): VerifyResult {
  if (!signed || typeof signed !== "object" || !signed.receipt || typeof signed.receipt !== "object") {
    return { ok: false, reason: "malformed_receipt" };
  }
  if (typeof signed.signature !== "string" || !HEX128_RE.test(signed.signature)) {
    return { ok: false, reason: "malformed_signature" };
  }
  const fields = signed.receipt as Record<string, unknown>;

  if (fields.escrow_ref !== bindings.escrowRefPosted) {
    return { ok: false, reason: "wrong_escrow_ref" };
  }
  if (typeof fields.supplier_pkh !== "string" || fields.supplier_pkh !== bindings.advertSupplierPkh) {
    return { ok: false, reason: "wrong_supplier" };
  }
  if (!HEX64_RE.test(bindings.supplierPubKeyHex)) {
    return { ok: false, reason: "malformed_pub_key" };
  }
  const keyPkh = bytesToHex(blake2b(hexToBytes(bindings.supplierPubKeyHex), { dkLen: 28 }));
  if (keyPkh !== bindings.advertSupplierPkh.toLowerCase()) {
    return { ok: false, reason: "pub_key_not_supplier" };
  }

  if (typeof bindings.resultReceiptHashOnChain !== "string" || !HEX64_RE.test(bindings.resultReceiptHashOnChain)) {
    return { ok: false, reason: "no_result_receipt_hash_on_chain" };
  }
  const recomputed = receiptResultHash({
    receipt: signed.receipt as Receipt,
    signature: signed.signature,
  });
  if (recomputed !== bindings.resultReceiptHashOnChain.toLowerCase()) {
    return { ok: false, reason: "result_receipt_hash_mismatch" };
  }

  return { ok: true };
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}
