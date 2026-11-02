/**
 * Attestation contract datum and redeemers (Part 2 §4).
 *
 *   AttestationDatum  Constr 0, 16 fields in the §4 order
 *   AttStatus         { AttActive  AttRevoked { at, reason } }
 *   Anchor            { uri, sha256 }
 *   Link              { rel, target }
 *   AttestationMint   { Attest { seed }  Burn }
 *   AttestationSpend  { RevokeAtt { reason }  Contest  Withdraw }
 *
 * ByteArrays are lowercase hex. Fixed sizes: subject, issuer, issuer_id,
 * profile, digest, Anchor.sha256 and Link.target have 32 bytes; envelope_sig
 * has 64 bytes. Integers are safe integers; §4 gives them no other range.
 */

import type { OutputReference } from "../chain/ChainProvider.js";
import type { PlutusData } from "./plutus-data.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, readBool, readBytes, readConstr, readFields, readList,
  readNumber, readOption, readOutputReference, variantIndex, writeBool, writeBytes, writeList, writeNumber,
  writeOption, writeOutputReference,
} from "./plutus-schema.js";

export type AttStatus = { type: "AttActive" } | { type: "AttRevoked"; at: number; reason: number };

export interface Anchor {
  /** 1..256 bytes, hex. */
  uri: string;
  /** 32 bytes. */
  sha256: string;
}

export interface Link {
  /** 0 supersedes, 1 depends_on, 2 corroborates, 3 disputes. */
  rel: number;
  /** Token name of another attestation, 32 bytes. */
  target: string;
}

export interface AttestationDatum {
  subject: string;
  issuer: string;
  issuerId: string | null;
  attType: number;
  format: number | null;
  profile: string | null;
  digest: string;
  locator: string | null;
  envelopeSig: string | null;
  issuedAt: number;
  validFrom: number | null;
  validUntil: number | null;
  solicited: boolean;
  status: AttStatus;
  contested: Anchor | null;
  links: Link[];
}

export type AttestationMint = { type: "Attest"; seed: OutputReference } | { type: "Burn" };

export type AttestationSpend = { type: "RevokeAtt"; reason: number } | { type: "Contest" } | { type: "Withdraw" };

const STATUSES = ["AttActive", "AttRevoked"] as const;
const MINTS = ["Attest", "Burn"] as const;
const SPENDS = ["RevokeAtt", "Contest", "Withdraw"] as const;
const BYTES32 = 32;
const SIGNATURE_BYTES = 64;

function bytes32(value: string, path: string): PlutusData {
  return writeBytes(value, path, BYTES32);
}

function readBytes32(data: PlutusData, path: string): string {
  return readBytes(data, path, BYTES32);
}

function statusToData(value: AttStatus, path: string): PlutusData {
  const index = variantIndex(value, STATUSES, path);
  if (value.type === "AttActive") return constr(index, []);
  return constr(index, [writeNumber(value.at, at(path, "at")), writeNumber(value.reason, at(path, "reason"))]);
}

function statusFromData(data: PlutusData, path: string): AttStatus {
  const { index } = readConstr(data, path, STATUSES.length);
  if (index === 0) {
    readFields(data, path, 0, 0);
    return { type: "AttActive" };
  }
  const [atTime, reason] = readFields(data, path, 1, 2);
  return { type: "AttRevoked", at: readNumber(atTime!, at(path, "at")), reason: readNumber(reason!, at(path, "reason")) };
}

function anchorToData(value: Anchor, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an anchor");
  return constr(0, [writeBytes(value.uri, at(path, "uri")), bytes32(value.sha256, at(path, "sha256"))]);
}

function anchorFromData(data: PlutusData, path: string): Anchor {
  const [uri, sha256] = readFields(data, path, 0, 2);
  return { uri: readBytes(uri!, at(path, "uri")), sha256: readBytes32(sha256!, at(path, "sha256")) };
}

function linkToData(value: Link, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a link");
  return constr(0, [writeNumber(value.rel, at(path, "rel")), bytes32(value.target, at(path, "target"))]);
}

function linkFromData(data: PlutusData, path: string): Link {
  const [rel, target] = readFields(data, path, 0, 2);
  return { rel: readNumber(rel!, at(path, "rel")), target: readBytes32(target!, at(path, "target")) };
}

export function attestationDatumToData(value: AttestationDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an attestation datum");
  return constr(0, [
    bytes32(value.subject, at(path, "subject")),
    bytes32(value.issuer, at(path, "issuer")),
    writeOption(value.issuerId, at(path, "issuerId"), bytes32),
    writeNumber(value.attType, at(path, "attType")),
    writeOption(value.format, at(path, "format"), writeNumber),
    writeOption(value.profile, at(path, "profile"), bytes32),
    bytes32(value.digest, at(path, "digest")),
    writeOption(value.locator, at(path, "locator"), writeBytes),
    writeOption(value.envelopeSig, at(path, "envelopeSig"), (sig, q) => writeBytes(sig, q, SIGNATURE_BYTES)),
    writeNumber(value.issuedAt, at(path, "issuedAt")),
    writeOption(value.validFrom, at(path, "validFrom"), writeNumber),
    writeOption(value.validUntil, at(path, "validUntil"), writeNumber),
    writeBool(value.solicited, at(path, "solicited")),
    statusToData(value.status, at(path, "status")),
    writeOption(value.contested, at(path, "contested"), anchorToData),
    writeList(value.links, at(path, "links"), linkToData),
  ]);
}

export function attestationDatumFromData(data: PlutusData, path = ""): AttestationDatum {
  const f = readFields(data, path, 0, 16);
  return {
    subject: readBytes32(f[0]!, at(path, "subject")),
    issuer: readBytes32(f[1]!, at(path, "issuer")),
    issuerId: readOption(f[2]!, at(path, "issuerId"), readBytes32),
    attType: readNumber(f[3]!, at(path, "attType")),
    format: readOption(f[4]!, at(path, "format"), readNumber),
    profile: readOption(f[5]!, at(path, "profile"), readBytes32),
    digest: readBytes32(f[6]!, at(path, "digest")),
    locator: readOption(f[7]!, at(path, "locator"), readBytes),
    envelopeSig: readOption(f[8]!, at(path, "envelopeSig"), (sig, q) => readBytes(sig, q, SIGNATURE_BYTES)),
    issuedAt: readNumber(f[9]!, at(path, "issuedAt")),
    validFrom: readOption(f[10]!, at(path, "validFrom"), readNumber),
    validUntil: readOption(f[11]!, at(path, "validUntil"), readNumber),
    solicited: readBool(f[12]!, at(path, "solicited")),
    status: statusFromData(f[13]!, at(path, "status")),
    contested: readOption(f[14]!, at(path, "contested"), anchorFromData),
    links: readList(f[15]!, at(path, "links"), linkFromData),
  };
}

export function attestationMintToData(value: AttestationMint, path = ""): PlutusData {
  const index = variantIndex(value, MINTS, path);
  return value.type === "Attest" ? constr(index, [writeOutputReference(value.seed, at(path, "seed"))]) : constr(index, []);
}

export function attestationMintFromData(data: PlutusData, path = ""): AttestationMint {
  const { index } = readConstr(data, path, MINTS.length);
  if (index === 1) {
    readFields(data, path, 1, 0);
    return { type: "Burn" };
  }
  const [seed] = readFields(data, path, 0, 1);
  return { type: "Attest", seed: readOutputReference(seed!, at(path, "seed")) };
}

export function attestationSpendToData(value: AttestationSpend, path = ""): PlutusData {
  const index = variantIndex(value, SPENDS, path);
  return value.type === "RevokeAtt" ? constr(index, [writeNumber(value.reason, at(path, "reason"))]) : constr(index, []);
}

export function attestationSpendFromData(data: PlutusData, path = ""): AttestationSpend {
  const { index } = readConstr(data, path, SPENDS.length);
  if (index === 0) {
    const [reason] = readFields(data, path, 0, 1);
    return { type: "RevokeAtt", reason: readNumber(reason!, at(path, "reason")) };
  }
  readFields(data, path, index, 0);
  return { type: index === 1 ? "Contest" : "Withdraw" };
}

export function encodeAttestationDatum(value: AttestationDatum): string {
  return codec("encodeAttestationDatum", () => encodePlutusDataHex(attestationDatumToData(value)));
}

export function decodeAttestationDatum(hex: string): AttestationDatum {
  return codec("decodeAttestationDatum", () => attestationDatumFromData(decodeHexData(hex)));
}

export function encodeAttestationMint(value: AttestationMint): string {
  return codec("encodeAttestationMint", () => encodePlutusDataHex(attestationMintToData(value)));
}

export function decodeAttestationMint(hex: string): AttestationMint {
  return codec("decodeAttestationMint", () => attestationMintFromData(decodeHexData(hex)));
}

export function encodeAttestationSpend(value: AttestationSpend): string {
  return codec("encodeAttestationSpend", () => encodePlutusDataHex(attestationSpendToData(value)));
}

export function decodeAttestationSpend(hex: string): AttestationSpend {
  return codec("decodeAttestationSpend", () => attestationSpendFromData(decodeHexData(hex)));
}
