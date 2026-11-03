/**
 * New escrow datum and escrow redeemers (Part 2 §6.1).
 *
 * On-chain encoding: Constr 0 with 16 fields. Fields 0..13 are the legacy
 * EscrowDatum fields in the legacy order (see EscrowDatum.ts), then:
 *   14 agent_id  ByteArray(32)
 *   15 refund    Option<Refund>, Refund = Constr 0 [address: Address, datum: Option<Data>]
 *
 * EscrowRedeemer keeps the legacy constructors and appends RefundRevoked:
 *   Claim 0, Submit { receipt_hash } 1, Accept 2, Reclaim 3, Release 4, RefundRevoked 5.
 *
 * TypeScript field names stay snake_case, as in the legacy EscrowDatum. Unlike
 * the legacy decoder, this codec checks byte lengths (28-byte key hashes,
 * 32-byte hashes and agent_id) and rejects text that is not valid UTF-8.
 */

import type { EscrowDatum, EscrowState } from "./types.js";
import type { PlutusData } from "./plutus-data.js";
import { decodeEscrowDatum } from "./EscrowDatum.js";
import { plutusAddressFromData, plutusAddressToData, type PlutusAddress } from "./address.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, readBigInt, readBytes, readConstr, readEnum, readFields,
  readNumber, readOption, readOutputReference, readText, variantIndex, writeBigInt, writeBytes, writeEnum,
  writeNumber, writeOption, writeOutputReference, writeText,
} from "./plutus-schema.js";

/** Where buyer payouts go. `datum: null` means an output without a datum. */
export interface Refund {
  address: PlutusAddress;
  datum: PlutusData | null;
}

export interface IdentityEscrowDatum extends EscrowDatum {
  /** 32-byte identifier of the agent, from the advert. */
  agent_id: string;
  /** null: buyer payouts go to the buyer key (legacy rule). */
  refund: Refund | null;
}

export type EscrowRedeemer =
  | { type: "Claim" }
  | { type: "Submit"; receipt_hash: string }
  | { type: "Accept" }
  | { type: "Reclaim" }
  | { type: "Release" }
  | { type: "RefundRevoked" };

export type AnyEscrowDatum =
  | { layout: "legacy"; datum: EscrowDatum }
  | { layout: "identity"; datum: IdentityEscrowDatum };

const ESCROW_STATES: readonly EscrowState[] = ["Open", "Claimed", "Submitted", "Accepted", "Reclaimed", "Released"];
const REDEEMERS = ["Claim", "Submit", "Accept", "Reclaim", "Release", "RefundRevoked"] as const;
const HASH28 = 28;
const BYTES32 = 32;
const LEGACY_FIELDS = 14;
const IDENTITY_FIELDS = 16;

function refundToData(value: Refund, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a refund");
  return constr(0, [
    plutusAddressToData(value.address, at(path, "address")),
    writeOption(value.datum, at(path, "datum"), (datum) => datum),
  ]);
}

function refundFromData(data: PlutusData, path: string): Refund {
  const [address, datum] = readFields(data, path, 0, 2);
  return {
    address: plutusAddressFromData(address!, at(path, "address")),
    datum: readOption(datum!, at(path, "datum"), (inner) => inner),
  };
}

export function identityEscrowDatumToData(value: IdentityEscrowDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an escrow datum");
  return constr(0, [
    writeBytes(value.buyer_pkh, at(path, "buyer_pkh"), HASH28),
    writeBytes(value.supplier_pkh, at(path, "supplier_pkh"), HASH28),
    writeOutputReference(value.advert_ref, at(path, "advert_ref")),
    writeText(value.capability_id, at(path, "capability_id")),
    writeBytes(value.request_spec_hash, at(path, "request_spec_hash"), BYTES32),
    writeBytes(value.prompt_hash, at(path, "prompt_hash"), BYTES32),
    writeBigInt(value.payment_lovelace, at(path, "payment_lovelace")),
    writeBigInt(value.buyer_bond_lovelace, at(path, "buyer_bond_lovelace")),
    writeBigInt(value.supplier_bond_lovelace, at(path, "supplier_bond_lovelace")),
    writeNumber(value.deliver_by, at(path, "deliver_by")),
    writeNumber(value.posted_at, at(path, "posted_at")),
    writeOption(value.submitted_at, at(path, "submitted_at"), writeNumber),
    writeOption(value.result_receipt_hash, at(path, "result_receipt_hash"), (hash, q) => writeBytes(hash, q, BYTES32)),
    writeEnum(value.state, ESCROW_STATES, at(path, "state")),
    writeBytes(value.agent_id, at(path, "agent_id"), BYTES32),
    writeOption(value.refund, at(path, "refund"), refundToData),
  ]);
}

export function identityEscrowDatumFromData(data: PlutusData, path = ""): IdentityEscrowDatum {
  const f = readFields(data, path, 0, IDENTITY_FIELDS);
  return {
    buyer_pkh: readBytes(f[0]!, at(path, "buyer_pkh"), HASH28),
    supplier_pkh: readBytes(f[1]!, at(path, "supplier_pkh"), HASH28),
    advert_ref: readOutputReference(f[2]!, at(path, "advert_ref")),
    capability_id: readText(f[3]!, at(path, "capability_id")),
    request_spec_hash: readBytes(f[4]!, at(path, "request_spec_hash"), BYTES32),
    prompt_hash: readBytes(f[5]!, at(path, "prompt_hash"), BYTES32),
    payment_lovelace: readBigInt(f[6]!, at(path, "payment_lovelace")),
    buyer_bond_lovelace: readBigInt(f[7]!, at(path, "buyer_bond_lovelace")),
    supplier_bond_lovelace: readBigInt(f[8]!, at(path, "supplier_bond_lovelace")),
    deliver_by: readNumber(f[9]!, at(path, "deliver_by")),
    posted_at: readNumber(f[10]!, at(path, "posted_at")),
    submitted_at: readOption(f[11]!, at(path, "submitted_at"), readNumber),
    result_receipt_hash: readOption(f[12]!, at(path, "result_receipt_hash"), (hash, q) => readBytes(hash, q, BYTES32)),
    state: readEnum(f[13]!, at(path, "state"), ESCROW_STATES),
    agent_id: readBytes(f[14]!, at(path, "agent_id"), BYTES32),
    refund: readOption(f[15]!, at(path, "refund"), refundFromData),
  };
}

export function encodeIdentityEscrowDatum(value: IdentityEscrowDatum): string {
  return codec("encodeIdentityEscrowDatum", () => encodePlutusDataHex(identityEscrowDatumToData(value)));
}

export function decodeIdentityEscrowDatum(hex: string): IdentityEscrowDatum {
  return codec("decodeIdentityEscrowDatum", () => identityEscrowDatumFromData(decodeHexData(hex)));
}

/** Read either escrow layout (needed until the drain ends, Part 2 §6.5). The legacy layout uses the legacy decoder. */
export function decodeAnyEscrowDatum(hex: string): AnyEscrowDatum {
  return codec("decodeAnyEscrowDatum", () => {
    const data = decodeHexData(hex);
    const fields = data.kind === "constr" ? data.fields.length : -1;
    if (fields === LEGACY_FIELDS) return { layout: "legacy", datum: decodeEscrowDatum(hex) };
    if (fields === IDENTITY_FIELDS) return { layout: "identity", datum: identityEscrowDatumFromData(data) };
    return fail("", `expected a constructor with ${LEGACY_FIELDS} (legacy) or ${IDENTITY_FIELDS} (identity) fields`);
  });
}

export function escrowRedeemerToData(value: EscrowRedeemer, path = ""): PlutusData {
  const index = variantIndex(value, REDEEMERS, path);
  if (value.type === "Submit") return constr(index, [writeBytes(value.receipt_hash, at(path, "receipt_hash"), BYTES32)]);
  return constr(index, []);
}

export function escrowRedeemerFromData(data: PlutusData, path = ""): EscrowRedeemer {
  const { index } = readConstr(data, path, REDEEMERS.length);
  const type = REDEEMERS[index]!;
  if (type === "Submit") {
    const [hash] = readFields(data, path, index, 1);
    return { type, receipt_hash: readBytes(hash!, at(path, "receipt_hash"), BYTES32) };
  }
  readFields(data, path, index, 0);
  return { type };
}

export function encodeEscrowRedeemer(value: EscrowRedeemer): string {
  return codec("encodeEscrowRedeemer", () => encodePlutusDataHex(escrowRedeemerToData(value)));
}

export function decodeEscrowRedeemer(hex: string): EscrowRedeemer {
  return codec("decodeEscrowRedeemer", () => escrowRedeemerFromData(decodeHexData(hex)));
}
