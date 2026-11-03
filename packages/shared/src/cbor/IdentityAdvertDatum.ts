/**
 * New advert datum and advert redeemers (Part 2 §6.2).
 *
 * On-chain encoding: Constr 0 with 14 fields. Fields 0..12 are the legacy
 * AdvertDatum fields in the legacy order (see AdvertDatum.ts), then:
 *   13 agent_id  ByteArray(32)
 *
 * AdvertRedeemer: PostAdvert 0, UpdateAdvert 1, RetireAdvert 2 (as today).
 *
 * TypeScript field names stay snake_case, as in the legacy AdvertDatum. Unlike
 * the legacy decoder, this codec checks byte lengths (28-byte supplier_pkh,
 * 32-byte detail_hash and agent_id) and rejects text that is not valid UTF-8.
 */

import type { AdvertDatum, AdvertStatus } from "./types.js";
import type { PlutusData } from "./plutus-data.js";
import { decodeAdvertDatum } from "./AdvertDatum.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, readBigInt, readBytes, readEnum, readFields, readNumber,
  readText, variantIndex, writeBigInt, writeBytes, writeEnum, writeNumber, writeText,
} from "./plutus-schema.js";

export interface IdentityAdvertDatum extends AdvertDatum {
  /** 32-byte identifier of the agent. */
  agent_id: string;
}

export type AdvertRedeemer = { type: "PostAdvert" } | { type: "UpdateAdvert" } | { type: "RetireAdvert" };

export type AnyAdvertDatum =
  | { layout: "legacy"; datum: AdvertDatum }
  | { layout: "identity"; datum: IdentityAdvertDatum };

const ADVERT_STATUSES: readonly AdvertStatus[] = ["Active", "Retired"];
const REDEEMERS = ["PostAdvert", "UpdateAdvert", "RetireAdvert"] as const;
const HASH28 = 28;
const BYTES32 = 32;
const LEGACY_FIELDS = 13;
const IDENTITY_FIELDS = 14;

export function identityAdvertDatumToData(value: IdentityAdvertDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an advert datum");
  return constr(0, [
    writeBytes(value.supplier_pkh, at(path, "supplier_pkh"), HASH28),
    writeText(value.capability_id, at(path, "capability_id")),
    writeText(value.model, at(path, "model")),
    writeNumber(value.max_output_tokens, at(path, "max_output_tokens")),
    writeNumber(value.max_processing_ms, at(path, "max_processing_ms")),
    writeBigInt(value.price_lovelace, at(path, "price_lovelace")),
    writeBigInt(value.supplier_bond_lovelace, at(path, "supplier_bond_lovelace")),
    writeBigInt(value.buyer_bond_lovelace, at(path, "buyer_bond_lovelace")),
    writeText(value.endpoint_url, at(path, "endpoint_url")),
    writeText(value.detail_uri, at(path, "detail_uri")),
    writeBytes(value.detail_hash, at(path, "detail_hash"), BYTES32),
    writeNumber(value.advertised_at, at(path, "advertised_at")),
    writeEnum(value.status, ADVERT_STATUSES, at(path, "status")),
    writeBytes(value.agent_id, at(path, "agent_id"), BYTES32),
  ]);
}

export function identityAdvertDatumFromData(data: PlutusData, path = ""): IdentityAdvertDatum {
  const f = readFields(data, path, 0, IDENTITY_FIELDS);
  return {
    supplier_pkh: readBytes(f[0]!, at(path, "supplier_pkh"), HASH28),
    capability_id: readText(f[1]!, at(path, "capability_id")),
    model: readText(f[2]!, at(path, "model")),
    max_output_tokens: readNumber(f[3]!, at(path, "max_output_tokens")),
    max_processing_ms: readNumber(f[4]!, at(path, "max_processing_ms")),
    price_lovelace: readBigInt(f[5]!, at(path, "price_lovelace")),
    supplier_bond_lovelace: readBigInt(f[6]!, at(path, "supplier_bond_lovelace")),
    buyer_bond_lovelace: readBigInt(f[7]!, at(path, "buyer_bond_lovelace")),
    endpoint_url: readText(f[8]!, at(path, "endpoint_url")),
    detail_uri: readText(f[9]!, at(path, "detail_uri")),
    detail_hash: readBytes(f[10]!, at(path, "detail_hash"), BYTES32),
    advertised_at: readNumber(f[11]!, at(path, "advertised_at")),
    status: readEnum(f[12]!, at(path, "status"), ADVERT_STATUSES),
    agent_id: readBytes(f[13]!, at(path, "agent_id"), BYTES32),
  };
}

export function encodeIdentityAdvertDatum(value: IdentityAdvertDatum): string {
  return codec("encodeIdentityAdvertDatum", () => encodePlutusDataHex(identityAdvertDatumToData(value)));
}

export function decodeIdentityAdvertDatum(hex: string): IdentityAdvertDatum {
  return codec("decodeIdentityAdvertDatum", () => identityAdvertDatumFromData(decodeHexData(hex)));
}

/** Read either advert layout (needed until the switch, Part 2 §6.4). The legacy layout uses the legacy decoder. */
export function decodeAnyAdvertDatum(hex: string): AnyAdvertDatum {
  return codec("decodeAnyAdvertDatum", () => {
    const data = decodeHexData(hex);
    const fields = data.kind === "constr" ? data.fields.length : -1;
    if (fields === LEGACY_FIELDS) return { layout: "legacy", datum: decodeAdvertDatum(hex) };
    if (fields === IDENTITY_FIELDS) return { layout: "identity", datum: identityAdvertDatumFromData(data) };
    return fail("", `expected a constructor with ${LEGACY_FIELDS} (legacy) or ${IDENTITY_FIELDS} (identity) fields`);
  });
}

export function encodeAdvertRedeemer(value: AdvertRedeemer): string {
  return codec("encodeAdvertRedeemer", () => encodePlutusDataHex(constr(variantIndex(value, REDEEMERS, ""), [])));
}

export function decodeAdvertRedeemer(hex: string): AdvertRedeemer {
  return codec("decodeAdvertRedeemer", () => ({ type: readEnum(decodeHexData(hex), "", REDEEMERS) }));
}
