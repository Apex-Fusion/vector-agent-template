/**
 * Identifiers, DNS-safe form, key hashes and DID strings (Part 1 §2, §3).
 */

import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, encodePlutusData, hexToBytes } from "../cbor/plutus-data.js";
import { codec, utf8Hex, utf8Text, writeOutputReference } from "../cbor/plutus-schema.js";

const VECTOR_ID_RE = /^[0-9a-f]{64}$/;
const POLICY_ID_RE = /^[0-9a-f]{56}$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const DID_PREFIX = "did:vector:";

/** True for 64 lowercase hexadecimal characters (Part 1 §3 `vector-id`). */
export function isVectorId(value: unknown): value is string {
  return typeof value === "string" && VECTOR_ID_RE.test(value);
}

function requireVectorId(id: unknown, label: string): string {
  if (!isVectorId(id)) throw new Error(`${label}: identifier must be 64 lowercase hexadecimal characters`);
  return id;
}

/**
 * `serialise(seed)` (Part 1 §3.1): the canonical Plutus Data CBOR of the
 * output reference, Constr 0 [tx_id, output_index].
 */
export function serialiseSeed(txId: string, index: number): Uint8Array {
  return codec("serialiseSeed", () => encodePlutusData(writeOutputReference({ txHash: txId, index }, "seed")));
}

/**
 * The identifier that a registration spending this seed mints (Part 1 §3.1):
 * hex(blake2b_256(serialise(seed))). Attestation and delegation token names
 * use the same derivation (Part 2 §4.1, §5.2).
 */
export function vectorIdFromSeed(txId: string, index: number): string {
  return bytesToHex(blake2b(serialiseSeed(txId, index), { dkLen: 32 }));
}

/** RFC 4648 base32 of the 32 identifier bytes, lowercase, without padding (Part 1 §3.2). */
export function dnsSafe(id: string): string {
  const bytes = hexToBytes(requireVectorId(id, "dnsSafe"));
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(buffer >> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/** Key hash (Part 1 §2): blake2b_224 of the public key bytes (32-byte Ed25519 or 33-byte P-256). */
export function keyHash(publicKey: string): string {
  const bytes = hexToBytes(publicKey, "keyHash");
  if (bytes.length !== 32 && bytes.length !== 33) throw new Error("keyHash: public key must have 32 or 33 bytes");
  return bytesToHex(blake2b(bytes, { dkLen: 28 }));
}

/** Canonical DID `did:vector:<vector-id>`. */
export function vectorDid(id: string): string {
  return `${DID_PREFIX}${requireVectorId(id, "vectorDid")}`;
}

/** Legacy DID `did:vector:agent:<policy>:<vector-id>`. */
export function legacyVectorDid(policyId: string, id: string): string {
  if (typeof policyId !== "string" || !POLICY_ID_RE.test(policyId)) {
    throw new Error("legacyVectorDid: policy ID must be 56 lowercase hexadecimal characters");
  }
  return `${DID_PREFIX}agent:${policyId}:${requireVectorId(id, "legacyVectorDid")}`;
}

/** DID URL of a listed key: `did:vector:<vector-id>#<key hash>`. A P-256 `pop` signs this string. */
export function vectorDidKeyUrl(id: string, publicKey: string): string {
  return `${vectorDid(id)}#${keyHash(publicKey)}`;
}

export type ParsedVectorDid =
  | { form: "canonical"; vectorId: string }
  | { form: "legacy"; policyId: string; vectorId: string }
  /** Reserved form; a resolver answers FEATURE_NOT_SUPPORTED. */
  | { form: "network"; network: "testnet"; vectorId: string };

/**
 * Parse a DID by the Part 1 §3 ABNF. All strings are case-sensitive and every
 * character is lowercase. Returns null for anything else, also for an
 * uppercase character, a DID URL or another method.
 */
export function parseVectorDid(did: string): ParsedVectorDid | null {
  if (typeof did !== "string" || !did.startsWith(DID_PREFIX)) return null;
  const rest = did.slice(DID_PREFIX.length);
  if (VECTOR_ID_RE.test(rest)) return { form: "canonical", vectorId: rest };
  const legacy = /^agent:([0-9a-f]{56}):([0-9a-f]{64})$/.exec(rest);
  if (legacy) return { form: "legacy", policyId: legacy[1]!, vectorId: legacy[2]! };
  const network = /^testnet:([0-9a-f]{64})$/.exec(rest);
  if (network) return { form: "network", network: "testnet", vectorId: network[1]! };
  return null;
}

/** UTF-8 bytes of a string as lowercase hex, for the text fields of the identity codecs. */
export function utf8ToHex(text: string): string {
  return utf8Hex(text, "utf8ToHex");
}

/** Text of a hex byte string, or null when the bytes are not valid UTF-8. */
export function utf8FromHex(hex: string): string | null {
  return utf8Text(hex, "utf8FromHex");
}
