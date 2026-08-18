/**
 * EscrowDatum CBOR codec — ARCHITECTURE.md §4.2.
 *
 * On-chain encoding: Plutus Constr0 (tag 121) wrapping an array of 14 fields
 * in declaration order:
 *   0  buyer_pkh              Uint8Array(28, raw)
 *   1  supplier_pkh           Uint8Array(28, raw)
 *   2  advert_ref             Tag 121 [txHash:bytes(32), index:int]
 *   3  capability_id          Uint8Array(UTF-8)
 *   4  request_spec_hash      Uint8Array(32, raw)
 *   5  prompt_hash            Uint8Array(32, raw)
 *   6  payment_lovelace       bigint
 *   7  buyer_bond_lovelace    bigint
 *   8  supplier_bond_lovelace bigint
 *   9  deliver_by             int (POSIX ms)
 *   10 posted_at              int (POSIX ms)
 *   11 submitted_at           Option<POSIXTime>  (None = Tag 122 [], Some v = Tag 121 [v])
 *   12 result_receipt_hash    Option<ByteArray>  (None = Tag 122 [], Some v = Tag 121 [v])
 *   13 state                  EscrowState: Open=121 … Released=126, each as Tag t []
 */

import { decode, Tag } from "cbor-x";
import type { EscrowDatum, EscrowState } from "./types.js";
import { plutusTag } from "./plutus-tag.js";
import { encodePlutus } from "./plutus-encoder.js";

export type { EscrowDatum };

// ─── Helpers ─────────────────────────────────────────────────────────

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
  const tagNumber = typeof value.tag === "number" ? value.tag : typeof value.value === "number" ? value.value : NaN;
  if (!Number.isFinite(tagNumber)) {
    throw new Error("malformed CBOR tag: no numeric tag number");
  }
  const payload = value.value;
  const fields = Array.isArray(payload) ? (payload as unknown[]) : [];
  return { tag: tagNumber, fields };
}

// ─── State tag map ───────────────────────────────────────────────────

const STATE_TAGS: Record<EscrowState, number> = {
  Open: 121,
  Claimed: 122,
  Submitted: 123,
  Accepted: 124,
  Reclaimed: 125,
  Released: 126,
};

const STATE_FROM_TAG: Record<number, EscrowState> = {
  121: "Open",
  122: "Claimed",
  123: "Submitted",
  124: "Accepted",
  125: "Reclaimed",
  126: "Released",
};

// ─── Option encoders ─────────────────────────────────────────────────

/** Coerce a JS number to BigInt for CBOR major-type-0/1 emission.
 * Plain `number` values are encoded as float64 by cbor-x for any value not
 * representable as a CBOR int8/16/32 — but Plutus integers require major type
 * 0 or 1 (positive/negative integer). CML.PlutusData.from_cbor_hex rejects
 * floats, which surfaces as a wasm "unreachable" error. Converting all integer
 * fields to BigInt before encoding sidesteps cbor-x's float heuristic. */
function intAsBig(value: number): bigint {
  return BigInt(value);
}

function encodeOptionInt(value: number | null): Tag {
  return value === null ? plutusTag(122, []) : plutusTag(121, [intAsBig(value)]);
}

function encodeOptionBytes(value: string | null): Tag {
  return value === null ? plutusTag(122, []) : plutusTag(121, [hexToBytes(value)]);
}

function decodeOptionInt(field: unknown): number | null {
  const info = extractTag(field);
  if (info.tag === 122) return null;
  if (info.tag === 121) {
    if (info.fields.length !== 1) {
      throw new Error(`Option Some must contain exactly one field, got ${info.fields.length}`);
    }
    return asInt(info.fields[0]);
  }
  throw new Error(`Option: expected tag 121 (Some) or 122 (None), got ${info.tag}`);
}

function decodeOptionBytes(field: unknown): string | null {
  const info = extractTag(field);
  if (info.tag === 122) return null;
  if (info.tag === 121) {
    if (info.fields.length !== 1) {
      throw new Error(`Option Some must contain exactly one field, got ${info.fields.length}`);
    }
    return bytesToHex(info.fields[0]);
  }
  throw new Error(`Option: expected tag 121 (Some) or 122 (None), got ${info.tag}`);
}

// ─── Encode ──────────────────────────────────────────────────────────

export function encodeEscrowDatum(d: EscrowDatum): string {
  const stateTagNumber = STATE_TAGS[d.state];
  if (stateTagNumber === undefined) {
    throw new Error(`unknown EscrowState: ${String(d.state)}`);
  }

  const advertRefTag = plutusTag(121, [
    hexToBytes(d.advert_ref.txHash),
    intAsBig(d.advert_ref.index),
  ]);

  const cbor = plutusTag(121, [
    hexToBytes(d.buyer_pkh),
    hexToBytes(d.supplier_pkh),
    advertRefTag,
    utf8Bytes(d.capability_id),
    hexToBytes(d.request_spec_hash),
    hexToBytes(d.prompt_hash),
    d.payment_lovelace,
    d.buyer_bond_lovelace,
    d.supplier_bond_lovelace,
    intAsBig(d.deliver_by),
    intAsBig(d.posted_at),
    encodeOptionInt(d.submitted_at),
    encodeOptionBytes(d.result_receipt_hash),
    plutusTag(stateTagNumber, []),
  ]);

  return bytesToHex(encodePlutus(cbor));
}

// ─── Decode ──────────────────────────────────────────────────────────

export function decodeEscrowDatum(hex: string): EscrowDatum {
  if (!hex || hex.length === 0) {
    throw new Error("decodeEscrowDatum: empty hex");
  }
  if (hex.length % 2 !== 0) {
    throw new Error("decodeEscrowDatum: hex has odd length");
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error("decodeEscrowDatum: non-hex characters");
  }

  let decoded: unknown;
  try {
    decoded = decode(hexToBytes(hex));
  } catch (err) {
    throw new Error(`decodeEscrowDatum: malformed CBOR: ${(err as Error).message}`);
  }

  const { tag, fields } = extractTag(decoded);
  if (tag !== 121) {
    throw new Error(`decodeEscrowDatum: expected Constr0 tag 121, got ${tag}`);
  }
  if (fields.length !== 14) {
    throw new Error(`decodeEscrowDatum: expected 14 fields, got ${fields.length}`);
  }

  // advert_ref
  const advertRef = extractTag(fields[2]);
  if (advertRef.tag !== 121) {
    throw new Error(`decodeEscrowDatum: advert_ref expected tag 121, got ${advertRef.tag}`);
  }
  if (advertRef.fields.length !== 2) {
    throw new Error(`decodeEscrowDatum: advert_ref expected 2 fields, got ${advertRef.fields.length}`);
  }

  // state
  const stateField = fields[13];
  if (!(stateField instanceof Tag)) {
    throw new Error("decodeEscrowDatum: state must be a CBOR Tag");
  }
  const stateInfo = extractTag(stateField);
  const state = STATE_FROM_TAG[stateInfo.tag];
  if (!state) {
    throw new Error(`decodeEscrowDatum: unknown EscrowState tag ${stateInfo.tag}`);
  }

  return {
    buyer_pkh: bytesToHex(fields[0]),
    supplier_pkh: bytesToHex(fields[1]),
    advert_ref: {
      txHash: bytesToHex(advertRef.fields[0]),
      index: asInt(advertRef.fields[1]),
    },
    capability_id: utf8Decode(fields[3]),
    request_spec_hash: bytesToHex(fields[4]),
    prompt_hash: bytesToHex(fields[5]),
    payment_lovelace: asBigInt(fields[6]),
    buyer_bond_lovelace: asBigInt(fields[7]),
    supplier_bond_lovelace: asBigInt(fields[8]),
    deliver_by: asInt(fields[9]),
    posted_at: asInt(fields[10]),
    submitted_at: decodeOptionInt(fields[11]),
    result_receipt_hash: decodeOptionBytes(fields[12]),
    state,
  };
}
