/**
 * Shared Plutus CBOR machinery, not datum construction logic.
 * Byte strings must be bare and split into chunks of at most 64 bytes.
 * Preserve existing encodings when no field needs chunks. Native ledger parsers
 * reject a definite 65-byte string even though a generic CBOR parser accepts it.
 */
import { Encoder, Tag } from "cbor-x";
import { Cbor, CborArray, CborBytes, CborMap, CborTag, CborUInt, CborNegInt, CborText } from "@harmoniclabs/cbor";
import type { CborObj } from "@harmoniclabs/cbor";
import { registerPlutusTagExtension } from "./plutus-tag.js";

registerPlutusTagExtension();
const plutusEncoder = new Encoder({ tagUint8Array: false });

function needsChunks(value: unknown): boolean {
  if (value instanceof Uint8Array) return value.length > 64;
  if (value instanceof Tag) {
    return needsChunks(typeof value.value === "number" && Array.isArray(value.tag) ? value.tag : value.value);
  }
  if (Array.isArray(value)) {
    for (const item of value) if (needsChunks(item)) return true;
  } else if (value instanceof Map) {
    for (const [key, item] of value) if (needsChunks(key) || needsChunks(item)) return true;
  } else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) if (needsChunks((value as Record<string, unknown>)[key])) return true;
  }
  return false;
}

function chunkBytes(node: CborObj): void {
  if (node instanceof CborBytes && node.chunks instanceof Uint8Array && node.chunks.length > 64) {
    const bytes = node.chunks;
    const chunks: CborBytes[] = [];
    for (let offset = 0; offset < bytes.length; offset += 64) {
      const chunk = bytes.subarray(offset, offset + 64);
      chunks.push(new CborBytes(chunk, chunk.length < 24 ? chunk.length : 24));
    }
    node.chunks = chunks;
    node.addInfos = 31;
  } else if (node instanceof CborArray) {
    for (const child of node.array) chunkBytes(child);
  } else if (node instanceof CborMap) {
    for (const pair of node.map) { chunkBytes(pair.k); chunkBytes(pair.v); }
  } else if (node instanceof CborTag) {
    chunkBytes(node.data);
  }
}

export function encodePlutus(value: unknown): Uint8Array {
  const encoded = plutusEncoder.encode(value);
  if (!needsChunks(value)) return encoded;
  const tree = Cbor.parse(encoded);
  chunkBytes(tree);
  return Cbor.encode(tree).toBuffer();
}

function decodedValue(node: CborObj): unknown {
  if (node instanceof CborBytes) return node.chunks instanceof Uint8Array ? node.chunks : node.bytes;
  if (node instanceof CborUInt || node instanceof CborNegInt) return node.num;
  if (node instanceof CborArray) return node.array.map(decodedValue);
  if (node instanceof CborMap) return new Map(node.map.map(({ k, v }) => [decodedValue(k), decodedValue(v)]));
  if (node instanceof CborTag) {
    const tag = Number(node.tag);
    if (!Number.isSafeInteger(tag)) throw new Error("CBOR tag exceeds the safe integer range");
    return new Tag(decodedValue(node.data), tag);
  }
  if (node instanceof CborText) return node.text;
  // Plutus Data has no floating-point or simple values.
  throw new Error("Unsupported Plutus CBOR node");
}

/** cbor-x does not read indefinite byte strings; accept native ledger chunks too. */
export function decodePlutus(bytes: Uint8Array): unknown {
  const { parsed, offset } = Cbor.parseWithOffset(bytes);
  if (offset !== bytes.length) throw new Error("Trailing data after Plutus CBOR");
  return decodedValue(parsed);
}
