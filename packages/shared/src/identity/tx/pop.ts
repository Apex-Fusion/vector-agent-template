/**
 * Proof of possession (`pop`) of a P-256 listed key (Part 1 §5): an ES256
 * signature, r ‖ s (32 bytes each, big-endian), by the key over the UTF-8
 * string `did:vector:<vector-id>#<key hash>`. The contract checks only the
 * 64-byte length; resolvers and gateways check the signature.
 *
 * Uses the Web Crypto API (W3C Web Cryptography API,
 * https://www.w3.org/TR/WebCryptoAPI/): ECDSA with P-256 and SHA-256, whose
 * signatures are r ‖ s (IEEE P1363), the `pop` form. Available in browsers and
 * in Node.js 20 as `globalThis.crypto`. The key point is SEC 1 v2
 * (https://www.secg.org/sec1-v2.pdf) §2.3.3 compressed form, 33 bytes.
 */

import { bytesToHex, hexToBytes } from "../../cbor/plutus-data.js";
import { vectorDidKeyUrl } from "../id.js";

/** The bytes that a P-256 key signs for its pop: UTF-8 `did:vector:<id>#<key hash>`. */
export function p256PopMessage(vectorId: string, compressedKeyHex: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(vectorDidKeyUrl(vectorId, compressedKeyHex));
}

/** The 33-byte compressed form of a 65-byte uncompressed point (0x04 ‖ x ‖ y). */
export function compressP256(uncompressed: Uint8Array): Uint8Array {
  if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) throw new Error("compressP256: expected a 65-byte uncompressed point");
  const out = new Uint8Array(33);
  out[0] = (uncompressed[64]! & 1) === 1 ? 0x03 : 0x02;
  out.set(uncompressed.subarray(1, 33), 1);
  return out;
}

// P-256 domain parameters (SEC 2 v2 §2.4.2, https://www.secg.org/sec2-v2.pdf).
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

const toBigInt = (bytes: Uint8Array): bigint => BigInt(`0x${bytesToHex(bytes) || "0"}`);
const toBytes32 = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, "0"));

/** The 65-byte uncompressed point of a 33-byte compressed P-256 key; throws when x is not on the curve. */
export function decompressP256(compressed: Uint8Array): Uint8Array {
  if (compressed.length !== 33 || (compressed[0] !== 0x02 && compressed[0] !== 0x03)) {
    throw new Error("decompressP256: expected a 33-byte compressed point");
  }
  const x = toBigInt(compressed.subarray(1));
  if (x >= P) throw new Error("decompressP256: x is not a field element");
  const rhs = (((x * x) % P) * x - 3n * x + B) % P;
  const rhsMod = (rhs + P) % P;
  // P ≡ 3 (mod 4), so a square root is rhs^((P + 1) / 4).
  let y = modPow(rhsMod, (P + 1n) / 4n, P);
  if ((y * y) % P !== rhsMod) throw new Error("decompressP256: the point is not on the curve");
  if ((y & 1n) !== BigInt(compressed[0]! & 1)) y = P - y;
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(toBytes32(x), 1);
  out.set(toBytes32(y), 33);
  return out;
}

const ECDSA = { name: "ECDSA", hash: "SHA-256" } as const;

/**
 * Creates the pop of a P-256 key pair for the record `vectorId`. Returns the
 * compressed public key and the pop, both hex, for `p256Key(key, purposes, pop)`.
 * For a Register, the identifier comes from the seed (`vectorIdFromSeed`).
 */
export async function createP256Pop(vectorId: string, keyPair: { privateKey: CryptoKey; publicKey: CryptoKey }): Promise<{ key: string; pop: string }> {
  const raw = new Uint8Array(await globalThis.crypto.subtle.exportKey("raw", keyPair.publicKey));
  const key = bytesToHex(compressP256(raw));
  const signature = new Uint8Array(await globalThis.crypto.subtle.sign(ECDSA, keyPair.privateKey, p256PopMessage(vectorId, key)));
  if (signature.length !== 64) throw new Error("createP256Pop: the signature is not 64 bytes (r ‖ s)");
  return { key, pop: bytesToHex(signature) };
}

/** True when `pop` is a valid ES256 signature of the key over its DID URL in the record `vectorId`. */
export async function verifyP256Pop(vectorId: string, compressedKeyHex: string, popHex: string): Promise<boolean> {
  try {
    const point = Uint8Array.from(decompressP256(hexToBytes(compressedKeyHex)));
    const publicKey = await globalThis.crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await globalThis.crypto.subtle.verify(ECDSA, publicKey, Uint8Array.from(hexToBytes(popHex)), p256PopMessage(vectorId, compressedKeyHex));
  } catch {
    return false;
  }
}
