/**
 * Signing helpers for the unsigned transactions of the builders: the
 * transaction ID and the merge of key witnesses into the witness set. The
 * body bytes stay exactly as built, so the transaction ID does not change
 * while each key holder signs in turn (Part 2 §10).
 */

import * as ed from "@noble/ed25519";
import { hexToBytes } from "../../cbor/plutus-data.js";
import { cborArray, cborMap, cborSet, cborUint, readCbor, type CborItem } from "./cbor.js";
import { blake2b256Hex, bytesToHex, encodeVKeyWitness, type VKeyWitness } from "./ledger.js";

function parts(txCborHex: string): { bytes: Uint8Array; items: CborItem[] } {
  const bytes = hexToBytes(txCborHex, "transaction");
  const tx = readCbor(bytes);
  if (tx.kind !== "array" || tx.items.length !== 4) throw new Error("not a Conway transaction: expected [body, witness set, valid, auxiliary data]");
  return { bytes, items: tx.items };
}

/** The transaction ID: blake2b-256 of the body bytes. The signature of each key holder covers it. */
export function transactionId(txCborHex: string): string {
  const { bytes, items } = parts(txCborHex);
  return blake2b256Hex(bytes.slice(items[0]!.start, items[0]!.end));
}

/** Adds key witnesses (Ed25519 public key and signature of the transaction ID); keeps existing ones and every other part. */
export function addVKeyWitnesses(txCborHex: string, witnesses: readonly VKeyWitness[]): string {
  const { bytes, items } = parts(txCborHex);
  const raw = (item: CborItem): Uint8Array => bytes.slice(item.start, item.end);
  const witnessSet = items[1]!;
  if (witnessSet.kind !== "map") throw new Error("the witness set is not a map");
  const existing: Uint8Array[] = [];
  const seen = new Set<string>();
  const others: Array<readonly [bigint, Uint8Array, Uint8Array]> = [];
  for (const [key, value] of witnessSet.entries) {
    if (key.kind !== "uint") throw new Error("a witness set key is not an unsigned integer");
    if (key.value !== 0n) {
      others.push([key.value, raw(key), raw(value)]);
      continue;
    }
    const list = value.kind === "tag" ? value.item : value;
    if (list.kind !== "array") throw new Error("the key witnesses are not an array");
    for (const w of list.items) {
      if (w.kind !== "array" || w.items[0]?.kind !== "bytes") throw new Error("a key witness is not [vkey, signature]");
      seen.add(bytesToHex(w.items[0].value));
      existing.push(raw(w));
    }
  }
  for (const w of witnesses) {
    if (seen.has(w.vkey)) continue;
    seen.add(w.vkey);
    existing.push(encodeVKeyWitness(w));
  }
  const entries: Array<readonly [bigint, Uint8Array, Uint8Array]> = [...others];
  if (existing.length > 0) entries.push([0n, cborUint(0), cborSet(existing)]);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const set = cborMap(entries.map(([, k, v]) => [k, v] as const));
  return bytesToHex(cborArray([raw(items[0]!), set, raw(items[2]!), raw(items[3]!)]));
}

/**
 * Signs the transaction ID with a raw 32-byte Ed25519 private key (hex) and
 * adds the key witness. Uses the async API of @noble/ed25519 (Web Crypto
 * SHA-512), so it runs in browsers and in Node.js.
 */
export async function signTransaction(txCborHex: string, privateKeyHex: string): Promise<string> {
  const privateKey = hexToBytes(privateKeyHex, "private key");
  const id = hexToBytes(transactionId(txCborHex), "transaction ID");
  const [publicKey, signature] = await Promise.all([ed.getPublicKeyAsync(privateKey), ed.signAsync(id, privateKey)]);
  return addVKeyWitnesses(txCborHex, [{ vkey: bytesToHex(publicKey), signature: bytesToHex(signature) }]);
}
