/**
 * receipt/sign.ts — Ed25519 sign a Receipt using the supplier private key.
 *
 * signReceipt(receipt, privateKeyHex) -> { receipt, signature: hex }
 *   Signature is Ed25519 over canonical(receipt) (UTF-8 bytes). 64-byte hex.
 *   Ed25519 is deterministic per RFC 8032 — same key + same msg ⇒ same sig.
 *
 * receiptResultHash({ receipt, signature }) -> 32-byte hex
 *   = sha256(canonical({ receipt, signature })) — written on-chain as
 *     EscrowDatum.result_receipt_hash on Submit.
 *
 * Implementation note: @noble/ed25519 v2 sync API requires a sha512
 * implementation to be installed at module load (etc.sha512Sync). We wire
 * Node's built-in createHash("sha512") here — that keeps the supplier-side
 * dependency surface minimal (no @noble/hashes).
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { canonicalize } from "../cbor/canonical.js";
import type { Receipt } from "./build.js";

// Install sha512 for @noble/ed25519 sync mode (idempotent — last assignment wins).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

export interface SignedReceipt {
  receipt: Receipt;
  signature: string;  // 64-byte hex Ed25519 signature
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

export function signReceipt(receipt: Receipt, privateKeyHex: string): SignedReceipt {
  if (typeof privateKeyHex !== "string" || privateKeyHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error("signReceipt: privateKeyHex must be a 32-byte (64-char) hex string");
  }
  const msg = utf8(canonicalize(receipt));
  const sig = ed.sign(msg, privateKeyHex);
  return { receipt, signature: bytesToHex(sig) };
}

export function receiptResultHash(signed: SignedReceipt): string {
  const canonical = canonicalize({ receipt: signed.receipt, signature: signed.signature });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
