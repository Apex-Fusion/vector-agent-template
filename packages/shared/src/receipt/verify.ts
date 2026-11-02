/**
 * receipt/verify.ts — Ed25519 verify a signed receipt against the supplier public key.
 *
 * verifyReceipt({ receipt, signature }, publicKeyHex) -> boolean
 *   Returns true iff `signature` is a valid Ed25519 signature over
 *   canonical(receipt) (UTF-8 bytes) under `publicKeyHex` (32-byte hex).
 *   Returns false on any failure: bad shape, bad signature, wrong key.
 *   Never throws — verification is a yes/no question for callers.
 *   It accepts 8-field and 9-field receipts: the signed bytes include every field.
 *
 * verifyEscrowReceipt({ receipt, signature }, publicKeyHex, escrow) -> boolean
 *   The Part 2 §6.3 verifier. It also binds the receipt to the escrow:
 *   - a new escrow (agent_id set): exactly the 9 fields, with
 *     agent_did = "did:vector:<agent_id>";
 *   - a legacy escrow (agent_id null or absent): exactly the 8 fields;
 *   - blake2b_224(publicKey) = the escrow's supplier_pkh;
 *   - the receipt's escrow_ref and supplier_pkh equal the escrow's values.
 *
 * Relies on the sha512 hook installed by ./sign.ts. We import it here
 * (transitively via SignedReceipt) so the side-effect runs whenever this
 * module is loaded.
 */

import * as ed from "@noble/ed25519";
import { canonicalize } from "../cbor/canonical.js";
import { isVectorId, keyHash, vectorDid } from "../identity/id.js";
import { AGENT_RECEIPT_FIELDS, RECEIPT_FIELDS } from "./fields.js";
import type { SignedReceipt } from "./sign.js";
// Side-effect import: ensure etc.sha512Sync is wired even if a caller imports
// verify.js without first importing sign.js.
import "./sign.js";

const PUBLIC_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** The escrow that a receipt answers. A decoded EscrowDatum or IdentityEscrowDatum plus its reference fits. */
export interface ReceiptEscrow {
  /** "<txHash>#<index>" that the receipt must name. */
  escrow_ref: string;
  /** supplier_pkh of the escrow datum (lowercase hex). */
  supplier_pkh: string;
  /** agent_id of a new escrow datum; null or absent for a legacy escrow. */
  agent_id?: string | null;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function verifyReceipt(signed: SignedReceipt, publicKeyHex: string): boolean {
  try {
    if (!signed || typeof signed !== "object") return false;
    if (typeof signed.signature !== "string") return false;
    if (!/^[0-9a-fA-F]{128}$/.test(signed.signature)) return false;
    if (typeof publicKeyHex !== "string" || !PUBLIC_KEY_RE.test(publicKeyHex)) {
      return false;
    }
    const msg = utf8(canonicalize(signed.receipt));
    return ed.verify(signed.signature, msg, publicKeyHex);
  } catch {
    return false;
  }
}

export function verifyEscrowReceipt(signed: SignedReceipt, publicKeyHex: string, escrow: ReceiptEscrow): boolean {
  try {
    if (!signed || typeof signed !== "object" || !escrow || typeof escrow !== "object") return false;
    const receipt = signed.receipt;
    if (!receipt || typeof receipt !== "object") return false;
    const agentId = escrow.agent_id ?? null;
    if (agentId !== null && !isVectorId(agentId)) return false;
    const fields: readonly string[] = agentId === null ? RECEIPT_FIELDS : AGENT_RECEIPT_FIELDS;
    if (Object.keys(receipt).length !== fields.length || !fields.every((field) => Object.hasOwn(receipt, field))) return false;
    if (agentId !== null && receipt.agent_did !== vectorDid(agentId)) return false;
    if (typeof publicKeyHex !== "string" || !PUBLIC_KEY_RE.test(publicKeyHex)) return false;
    if (keyHash(publicKeyHex) !== escrow.supplier_pkh) return false;
    if (receipt.supplier_pkh !== escrow.supplier_pkh || receipt.escrow_ref !== escrow.escrow_ref) return false;
    return verifyReceipt(signed, publicKeyHex);
  } catch {
    return false;
  }
}
