/**
 * Identity registry record (Part 1 §5) and legacy registry record codecs.
 *
 * Field and constructor order is exactly as in Part 1 §5. TypeScript fields
 * use camelCase. Every ByteArray is lowercase hex, also the UTF-8 text fields:
 * the contract does not check UTF-8, and a resolver must still read a record
 * whose text is not valid UTF-8 (Part 1 §8.2). Use utf8ToHex and utf8FromHex
 * from the identity module to convert text.
 *
 * The codecs check the shape of each value: constructor indices, field
 * counts, value kinds, the byte length of fixed-size fields (a key's length
 * follows its type; only a P-256 key has a 64-byte pop) and integer ranges
 * (times in [0, 253,402,300,799,999], all other integers in [0, 2^63)).
 * Counts, text limits, purpose and rights rules and other relations between
 * fields are validity rules of Part 2 §3.3; the codecs do not check them.
 */

import type { PlutusData } from "./plutus-data.js";
import { credentialFromData, credentialToData, type PlutusCredential } from "./address.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, NAT63_RANGE, readBigInt, readBytes, readConstr,
  readEnum, readFields, readList, readNumber, readOption, TIME_RANGE, variantIndex, writeBigInt, writeBytes,
  writeEnum, writeList, writeNumber, writeOption,
} from "./plutus-schema.js";

export const KEY_TYPES = ["Ed25519", "P256"] as const;
export type KeyType = (typeof KEY_TYPES)[number];

export const ROLES = ["Accountable", "Responsible", "Provider", "Distributor", "Guardian"] as const;
export type Role = (typeof ROLES)[number];

export interface Key {
  keyType: KeyType;
  /** 32 bytes (Ed25519) or 33 bytes (P-256 compressed point). */
  key: string;
  purposes: number;
  /** 64 bytes for a P-256 key; null for an Ed25519 key. */
  pop: string | null;
}

export type Signer =
  | { type: "KeyHash"; hash: string }
  | { type: "Script"; hash: string }
  | { type: "ControllerSet" };

export interface Party {
  role: Role;
  signer: Signer;
  /** UTF-8 bytes as hex. */
  organisation: string | null;
  notBefore: number;
  notAfter: number | null;
  rights: number;
  removalAfter: number | null;
}

export type Lineage =
  | { type: "Root" }
  | { type: "Subagent"; parent: string; parentEpoch: number; depth: number };

export interface Hold {
  by: Signer;
  reason: number;
  since: number;
  until: number;
}

export type Status =
  | { type: "Active" }
  | { type: "Suspended"; holds: Hold[] }
  | { type: "Revoked"; by: Signer; reason: number; at: number; invalidFrom: number | null; successor: string | null }
  | { type: "Retired"; at: number; successor: string | null };

export interface PendingRecovery {
  newController: string;
  effectiveAfter: number;
}

export interface IdentityDatum {
  /** Ed25519 public key, 32 bytes. */
  controller: string;
  keys: Key[];
  parties: Party[];
  guardianThreshold: number;
  pendingRecovery: PendingRecovery | null;
  lineage: Lineage;
  subagentEpoch: number;
  /** UTF-8 bytes as hex. */
  name: string;
  /** UTF-8 bytes as hex. */
  description: string;
  /** UTF-8 bytes as hex. */
  framework: string;
  /** UTF-8 URL bytes as hex. */
  endpoint: string;
  /** UTF-8 items as hex. */
  capabilities: string[];
  createdAt: number;
  status: Status;
}

/** Legacy registry record: Constr 0 with 7 fields. Its content is self-declared. */
export interface LegacyDatum {
  owner: PlutusCredential;
  name: string;
  description: string;
  capabilities: string[];
  framework: string;
  endpoint: string;
  /** Self-declared; any integer. */
  registeredAt: bigint;
}

const SIGNERS = ["KeyHash", "Script", "ControllerSet"] as const;
const LINEAGES = ["Root", "Subagent"] as const;
const STATUSES = ["Active", "Suspended", "Revoked", "Retired"] as const;
const KEY_BYTES: Record<KeyType, number> = { Ed25519: 32, P256: 33 };
const POP_BYTES = 64;
const HASH28 = 28;
const BYTES32 = 32;

function time(value: number, path: string): PlutusData {
  return writeNumber(value, path, TIME_RANGE);
}

function nat(value: number, path: string): PlutusData {
  return writeNumber(value, path, NAT63_RANGE);
}

function readTime(data: PlutusData, path: string): number {
  return readNumber(data, path, TIME_RANGE);
}

function readNat(data: PlutusData, path: string): number {
  return readNumber(data, path, NAT63_RANGE);
}

// ─── Signer ──────────────────────────────────────────────────────────

export function signerToData(value: Signer, path: string): PlutusData {
  const index = variantIndex(value, SIGNERS, path);
  if (value.type === "ControllerSet") return constr(index, []);
  return constr(index, [writeBytes(value.hash, at(path, "hash"), HASH28)]);
}

export function signerFromData(data: PlutusData, path: string): Signer {
  const { index } = readConstr(data, path, SIGNERS.length);
  if (index === 2) {
    readFields(data, path, 2, 0);
    return { type: "ControllerSet" };
  }
  const [hash] = readFields(data, path, index, 1);
  return { type: index === 0 ? "KeyHash" : "Script", hash: readBytes(hash!, at(path, "hash"), HASH28) };
}

// ─── Key ─────────────────────────────────────────────────────────────

function keyToData(value: Key, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a key");
  const keyType = writeEnum(value.keyType, KEY_TYPES, at(path, "keyType"));
  if (value.keyType === "P256" && value.pop === null) fail(at(path, "pop"), "a P256 key needs a 64-byte pop");
  if (value.keyType === "Ed25519" && value.pop !== null) fail(at(path, "pop"), "an Ed25519 key has no pop");
  return constr(0, [
    keyType,
    writeBytes(value.key, at(path, "key"), KEY_BYTES[value.keyType]),
    nat(value.purposes, at(path, "purposes")),
    writeOption(value.pop, at(path, "pop"), (pop, q) => writeBytes(pop, q, POP_BYTES)),
  ]);
}

function keyFromData(data: PlutusData, path: string): Key {
  const [keyType, key, purposes, pop] = readFields(data, path, 0, 4);
  const type = readEnum(keyType!, at(path, "keyType"), KEY_TYPES);
  const popValue = readOption(pop!, at(path, "pop"), (p, q) => readBytes(p, q, POP_BYTES));
  if (type === "P256" && popValue === null) fail(at(path, "pop"), "a P256 key needs a 64-byte pop");
  if (type === "Ed25519" && popValue !== null) fail(at(path, "pop"), "an Ed25519 key has no pop");
  return {
    keyType: type,
    key: readBytes(key!, at(path, "key"), KEY_BYTES[type]),
    purposes: readNat(purposes!, at(path, "purposes")),
    pop: popValue,
  };
}

// ─── Party ───────────────────────────────────────────────────────────

function partyToData(value: Party, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a party");
  return constr(0, [
    writeEnum(value.role, ROLES, at(path, "role")),
    signerToData(value.signer, at(path, "signer")),
    writeOption(value.organisation, at(path, "organisation"), writeBytes),
    time(value.notBefore, at(path, "notBefore")),
    writeOption(value.notAfter, at(path, "notAfter"), time),
    nat(value.rights, at(path, "rights")),
    writeOption(value.removalAfter, at(path, "removalAfter"), time),
  ]);
}

function partyFromData(data: PlutusData, path: string): Party {
  const [role, signer, organisation, notBefore, notAfter, rights, removalAfter] = readFields(data, path, 0, 7);
  return {
    role: readEnum(role!, at(path, "role"), ROLES),
    signer: signerFromData(signer!, at(path, "signer")),
    organisation: readOption(organisation!, at(path, "organisation"), readBytes),
    notBefore: readTime(notBefore!, at(path, "notBefore")),
    notAfter: readOption(notAfter!, at(path, "notAfter"), readTime),
    rights: readNat(rights!, at(path, "rights")),
    removalAfter: readOption(removalAfter!, at(path, "removalAfter"), readTime),
  };
}

// ─── Lineage, holds, status, recovery ────────────────────────────────

function lineageToData(value: Lineage, path: string): PlutusData {
  const index = variantIndex(value, LINEAGES, path);
  if (value.type === "Root") return constr(index, []);
  return constr(index, [
    writeBytes(value.parent, at(path, "parent"), BYTES32),
    nat(value.parentEpoch, at(path, "parentEpoch")),
    nat(value.depth, at(path, "depth")),
  ]);
}

function lineageFromData(data: PlutusData, path: string): Lineage {
  const { index } = readConstr(data, path, LINEAGES.length);
  if (index === 0) {
    readFields(data, path, 0, 0);
    return { type: "Root" };
  }
  const [parent, parentEpoch, depth] = readFields(data, path, 1, 3);
  return {
    type: "Subagent",
    parent: readBytes(parent!, at(path, "parent"), BYTES32),
    parentEpoch: readNat(parentEpoch!, at(path, "parentEpoch")),
    depth: readNat(depth!, at(path, "depth")),
  };
}

function holdToData(value: Hold, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a hold");
  return constr(0, [
    signerToData(value.by, at(path, "by")),
    nat(value.reason, at(path, "reason")),
    time(value.since, at(path, "since")),
    time(value.until, at(path, "until")),
  ]);
}

function holdFromData(data: PlutusData, path: string): Hold {
  const [by, reason, since, until] = readFields(data, path, 0, 4);
  return {
    by: signerFromData(by!, at(path, "by")),
    reason: readNat(reason!, at(path, "reason")),
    since: readTime(since!, at(path, "since")),
    until: readTime(until!, at(path, "until")),
  };
}

function successorToData(value: string | null, path: string): PlutusData {
  return writeOption(value, path, (s, q) => writeBytes(s, q, BYTES32));
}

function successorFromData(data: PlutusData, path: string): string | null {
  return readOption(data, path, (s, q) => readBytes(s, q, BYTES32));
}

function statusToData(value: Status, path: string): PlutusData {
  const index = variantIndex(value, STATUSES, path);
  switch (value.type) {
    case "Active":
      return constr(index, []);
    case "Suspended":
      return constr(index, [writeList(value.holds, at(path, "holds"), holdToData)]);
    case "Revoked":
      return constr(index, [
        signerToData(value.by, at(path, "by")),
        nat(value.reason, at(path, "reason")),
        time(value.at, at(path, "at")),
        writeOption(value.invalidFrom, at(path, "invalidFrom"), time),
        successorToData(value.successor, at(path, "successor")),
      ]);
    case "Retired":
      return constr(index, [time(value.at, at(path, "at")), successorToData(value.successor, at(path, "successor"))]);
  }
}

function statusFromData(data: PlutusData, path: string): Status {
  const { index } = readConstr(data, path, STATUSES.length);
  switch (index) {
    case 0:
      readFields(data, path, 0, 0);
      return { type: "Active" };
    case 1: {
      const [holds] = readFields(data, path, 1, 1);
      return { type: "Suspended", holds: readList(holds!, at(path, "holds"), holdFromData) };
    }
    case 2: {
      const [by, reason, atTime, invalidFrom, successor] = readFields(data, path, 2, 5);
      return {
        type: "Revoked",
        by: signerFromData(by!, at(path, "by")),
        reason: readNat(reason!, at(path, "reason")),
        at: readTime(atTime!, at(path, "at")),
        invalidFrom: readOption(invalidFrom!, at(path, "invalidFrom"), readTime),
        successor: successorFromData(successor!, at(path, "successor")),
      };
    }
    default: {
      const [atTime, successor] = readFields(data, path, 3, 2);
      return { type: "Retired", at: readTime(atTime!, at(path, "at")), successor: successorFromData(successor!, at(path, "successor")) };
    }
  }
}

function pendingRecoveryToData(value: PendingRecovery, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a pending recovery");
  return constr(0, [
    writeBytes(value.newController, at(path, "newController"), BYTES32),
    time(value.effectiveAfter, at(path, "effectiveAfter")),
  ]);
}

function pendingRecoveryFromData(data: PlutusData, path: string): PendingRecovery {
  const [newController, effectiveAfter] = readFields(data, path, 0, 2);
  return {
    newController: readBytes(newController!, at(path, "newController"), BYTES32),
    effectiveAfter: readTime(effectiveAfter!, at(path, "effectiveAfter")),
  };
}

// ─── IdentityDatum ───────────────────────────────────────────────────

export function identityDatumToData(value: IdentityDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an identity datum");
  return constr(0, [
    writeBytes(value.controller, at(path, "controller"), BYTES32),
    writeList(value.keys, at(path, "keys"), keyToData),
    writeList(value.parties, at(path, "parties"), partyToData),
    nat(value.guardianThreshold, at(path, "guardianThreshold")),
    writeOption(value.pendingRecovery, at(path, "pendingRecovery"), pendingRecoveryToData),
    lineageToData(value.lineage, at(path, "lineage")),
    nat(value.subagentEpoch, at(path, "subagentEpoch")),
    writeBytes(value.name, at(path, "name")),
    writeBytes(value.description, at(path, "description")),
    writeBytes(value.framework, at(path, "framework")),
    writeBytes(value.endpoint, at(path, "endpoint")),
    writeList(value.capabilities, at(path, "capabilities"), writeBytes),
    time(value.createdAt, at(path, "createdAt")),
    statusToData(value.status, at(path, "status")),
  ]);
}

export function identityDatumFromData(data: PlutusData, path = ""): IdentityDatum {
  const f = readFields(data, path, 0, 14);
  return {
    controller: readBytes(f[0]!, at(path, "controller"), BYTES32),
    keys: readList(f[1]!, at(path, "keys"), keyFromData),
    parties: readList(f[2]!, at(path, "parties"), partyFromData),
    guardianThreshold: readNat(f[3]!, at(path, "guardianThreshold")),
    pendingRecovery: readOption(f[4]!, at(path, "pendingRecovery"), pendingRecoveryFromData),
    lineage: lineageFromData(f[5]!, at(path, "lineage")),
    subagentEpoch: readNat(f[6]!, at(path, "subagentEpoch")),
    name: readBytes(f[7]!, at(path, "name")),
    description: readBytes(f[8]!, at(path, "description")),
    framework: readBytes(f[9]!, at(path, "framework")),
    endpoint: readBytes(f[10]!, at(path, "endpoint")),
    capabilities: readList(f[11]!, at(path, "capabilities"), readBytes),
    createdAt: readTime(f[12]!, at(path, "createdAt")),
    status: statusFromData(f[13]!, at(path, "status")),
  };
}

export function encodeIdentityDatum(value: IdentityDatum): string {
  return codec("encodeIdentityDatum", () => encodePlutusDataHex(identityDatumToData(value)));
}

export function decodeIdentityDatum(hex: string): IdentityDatum {
  return codec("decodeIdentityDatum", () => identityDatumFromData(decodeHexData(hex)));
}

// ─── LegacyDatum ─────────────────────────────────────────────────────

export function legacyDatumToData(value: LegacyDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a legacy datum");
  return constr(0, [
    credentialToData(value.owner, at(path, "owner")),
    writeBytes(value.name, at(path, "name")),
    writeBytes(value.description, at(path, "description")),
    writeList(value.capabilities, at(path, "capabilities"), writeBytes),
    writeBytes(value.framework, at(path, "framework")),
    writeBytes(value.endpoint, at(path, "endpoint")),
    writeBigInt(value.registeredAt, at(path, "registeredAt")),
  ]);
}

export function legacyDatumFromData(data: PlutusData, path = ""): LegacyDatum {
  const f = readFields(data, path, 0, 7);
  return {
    owner: credentialFromData(f[0]!, at(path, "owner")),
    name: readBytes(f[1]!, at(path, "name")),
    description: readBytes(f[2]!, at(path, "description")),
    capabilities: readList(f[3]!, at(path, "capabilities"), readBytes),
    framework: readBytes(f[4]!, at(path, "framework")),
    endpoint: readBytes(f[5]!, at(path, "endpoint")),
    registeredAt: readBigInt(f[6]!, at(path, "registeredAt")),
  };
}

export function encodeLegacyDatum(value: LegacyDatum): string {
  return codec("encodeLegacyDatum", () => encodePlutusDataHex(legacyDatumToData(value)));
}

export function decodeLegacyDatum(hex: string): LegacyDatum {
  return codec("decodeLegacyDatum", () => legacyDatumFromData(decodeHexData(hex)));
}
