/**
 * AdvertDatum CBOR codec — ARCHITECTURE.md §4.1.
 *
 * On-chain encoding: Plutus Constr0 (tag 121) wrapping an array of 13 fields
 * in declaration order:
 *   0  supplier_pkh            Uint8Array(28, raw)
 *   1  capability_id           Uint8Array(UTF-8)
 *   2  model                   Uint8Array(UTF-8)
 *   3  max_output_tokens       int
 *   4  max_processing_ms       int
 *   5  price_lovelace          bigint
 *   6  supplier_bond_lovelace  bigint
 *   7  buyer_bond_lovelace     bigint
 *   8  endpoint_url            Uint8Array(UTF-8)
 *   9  detail_uri              Uint8Array(UTF-8)
 *   10 detail_hash             Uint8Array(32, raw)
 *   11 advertised_at           int (POSIX ms)
 *   12 status                  Tag 121 [] = Active | Tag 122 [] = Retired
 *
 * This codec uses cbor-x with the Plutus Tag extension (see registerPlutusTagExtension).
 * The extension is registered once per process and is idempotent across modules that
 * re-register it (buyer-side and supplier-side fixtures do the same).
 */

import { decode, Tag } from "cbor-x";
import type { AdvertDatum, AdvertStatus } from "./types.js";
import { plutusTag } from "./plutus-tag.js";
import { encodePlutus } from "./plutus-encoder.js";

export type { AdvertDatum };

// ─── Byte helpers ────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex: odd length ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.substring(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`invalid hex characters at offset ${i}`);
    }
    bytes[i / 2] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: unknown): string {
  let view: Uint8Array;
  if (bytes instanceof Uint8Array) {
    view = bytes;
  } else if (Buffer.isBuffer(bytes)) {
    view = new Uint8Array((bytes as Buffer).buffer, (bytes as Buffer).byteOffset, (bytes as Buffer).byteLength);
  } else if (bytes instanceof ArrayBuffer) {
    view = new Uint8Array(bytes);
  } else {
    throw new Error(`expected bytes, got ${typeof bytes}`);
  }
  return Array.from(view)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(bytes: unknown): string {
  if (typeof bytes === "string") return bytes;
  if (bytes instanceof Uint8Array) return new TextDecoder().decode(bytes);
  if (Buffer.isBuffer(bytes)) return bytes.toString("utf8");
  throw new Error(`expected bytes for UTF-8 decode, got ${typeof bytes}`);
}

function asBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isInteger(v)) return BigInt(v);
  throw new Error(`expected integer, got ${typeof v}`);
}

function asInt(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "bigint") {
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(`integer out of safe range: ${v}`);
    }
    return Number(v);
  }
  throw new Error(`expected integer, got ${typeof v}`);
}

function extractTag(value: unknown): { tag: number; fields: unknown[] } {
  if (!(value instanceof Tag)) {
    throw new Error(`expected CBOR Tag, got ${typeof value}`);
  }
  // cbor-x decodes into Tag with standard shape: .tag = tagNumber, .value = payload.
  // Our Plutus-convention encoder uses the inverse shape (.value = tagNumber, .tag = payload)
  // but that only applies to the encode path; decode always yields standard shape.
  const tagNumber = typeof value.tag === "number" ? value.tag : typeof value.value === "number" ? value.value : NaN;
  if (!Number.isFinite(tagNumber)) {
    throw new Error("malformed CBOR tag: no numeric tag number");
  }
  const payload = value.value;
  const fields = Array.isArray(payload) ? (payload as unknown[]) : [];
  return { tag: tagNumber, fields };
}

// ─── Encode ──────────────────────────────────────────────────────────

export function encodeAdvertDatum(d: AdvertDatum): string {
  const statusTag =
    d.status === "Active"
      ? plutusTag(121, [])
      : d.status === "Retired"
        ? plutusTag(122, [])
        : (() => {
            throw new Error(`unknown AdvertStatus: ${String(d.status)}`);
          })();

  // cbor-x encodes JS Number as float64 (`fb` prefix) for values that don't
  // fit in CBOR's compact int forms — and Plutus Data has NO float type, so
  // CML's PlutusData.from_cbor_hex panics with "RuntimeError: unreachable"
  // when it sees one. Coerce numeric fields to BigInt so cbor-x always emits
  // CBOR major-type-0/1 integers. Mirrors the intAsBig pattern in EscrowDatum.
  const cbor = plutusTag(121, [
    hexToBytes(d.supplier_pkh),
    utf8Bytes(d.capability_id),
    utf8Bytes(d.model),
    BigInt(d.max_output_tokens),
    BigInt(d.max_processing_ms),
    d.price_lovelace,
    d.supplier_bond_lovelace,
    d.buyer_bond_lovelace,
    utf8Bytes(d.endpoint_url),
    utf8Bytes(d.detail_uri),
    hexToBytes(d.detail_hash),
    BigInt(d.advertised_at),
    statusTag,
  ]);

  return bytesToHex(encodePlutus(cbor));
}

// ─── Decode ──────────────────────────────────────────────────────────

const STATUS_MAP: Record<number, AdvertStatus> = {
  121: "Active",
  122: "Retired",
};

export function decodeAdvertDatum(hex: string): AdvertDatum {
  if (!hex || hex.length === 0) {
    throw new Error("decodeAdvertDatum: empty hex");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("decodeAdvertDatum: hex has odd length");
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("decodeAdvertDatum: non-hex characters");
  }

  let decoded: unknown;
  try {
    decoded = decode(hexToBytes(hex));
  } catch (err) {
    throw new Error(`decodeAdvertDatum: malformed CBOR: ${(err as Error).message}`);
  }

  const { tag, fields } = extractTag(decoded);
  if (tag !== 121) {
    throw new Error(`decodeAdvertDatum: expected Constr0 tag 121, got ${tag}`);
  }
  if (fields.length !== 13) {
    throw new Error(`decodeAdvertDatum: expected 13 fields, got ${fields.length}`);
  }

  const statusField = fields[12];
  if (!(statusField instanceof Tag)) {
    throw new Error("decodeAdvertDatum: status must be a CBOR Tag");
  }
  const statusInfo = extractTag(statusField);
  const status = STATUS_MAP[statusInfo.tag];
  if (!status) {
    throw new Error(`decodeAdvertDatum: unknown AdvertStatus tag ${statusInfo.tag}`);
  }

  return {
    supplier_pkh: bytesToHex(fields[0]),
    capability_id: utf8Decode(fields[1]),
    model: utf8Decode(fields[2]),
    max_output_tokens: asInt(fields[3]),
    max_processing_ms: asInt(fields[4]),
    price_lovelace: asBigInt(fields[5]),
    supplier_bond_lovelace: asBigInt(fields[6]),
    buyer_bond_lovelace: asBigInt(fields[7]),
    endpoint_url: utf8Decode(fields[8]),
    detail_uri: utf8Decode(fields[9]),
    detail_hash: bytesToHex(fields[10]),
    advertised_at: asInt(fields[11]),
    status,
  };
}
