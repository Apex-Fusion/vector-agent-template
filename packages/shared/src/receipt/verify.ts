/**
 * receipt/verify.ts — Ed25519 verify a signed receipt against the supplier public key.
 *
 * verifyReceipt({ receipt, signature }, publicKeyHex) -> boolean
 *   Returns true iff `signature` is a valid Ed25519 signature over
 *   canonical(receipt) (UTF-8 bytes) under `publicKeyHex` (32-byte hex).
 *   Returns false on any failure: bad shape, bad signature, wrong key.
 *   Never throws — verification is a yes/no question for callers.
 *
 * Relies on the sha512 hook installed by ./sign.ts. We import it here
 * (transitively via SignedReceipt) so the side-effect runs whenever this
 * module is loaded.
 */

import * as ed from "@noble/ed25519";
import { canonicalize } from "../cbor/canonical.js";
import type { SignedReceipt } from "./sign.js";
// Side-effect import: ensure etc.sha512Sync is wired even if a caller imports
// verify.js without first importing sign.js.
import "./sign.js";

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function verifyReceipt(signed: SignedReceipt, publicKeyHex: string): boolean {
  try {
    if (!signed || typeof signed !== "object") return false;
    if (typeof signed.signature !== "string") return false;
    if (!/^[0-9a-fA-F]{128}$/.test(signed.signature)) return false;
    if (typeof publicKeyHex !== "string" || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
      return false;
    }
    const msg = utf8(canonicalize(signed.receipt));
    return ed.verify(signed.signature, msg, publicKeyHex);
  } catch {
    return false;
  }
}
