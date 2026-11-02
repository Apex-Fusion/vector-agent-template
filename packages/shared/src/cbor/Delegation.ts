/**
 * Delegation records and vaults (Part 2 §5.2, §5.3).
 *
 *   Delegator       { PrincipalKey { hash, organisation }  Agent { id } }
 *   ValueLimit      Constr 0 [per_tx, total, period_ms]
 *   DelegationDatum Constr 0, 12 fields in the §5.2 order
 *   DelegationMint  { Delegate { seed }  Undelegate }
 *   VaultDatum      { Live { owner, delegation, spent, period_start }  Returned { owner } }
 *   VaultSpend      { Pay  Close }
 *
 * ByteArrays are lowercase hex; patterns and organisations are their UTF-8
 * bytes. Fixed sizes: PrincipalKey.hash and delegate_key have 28 bytes;
 * Agent.id, parent, delegate, purpose and the vault's delegation have 32
 * bytes. AP3X amounts are bigint; other integers are safe integers.
 */

import type { OutputReference } from "../chain/ChainProvider.js";
import type { PlutusData } from "./plutus-data.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, readBigInt, readBytes, readConstr, readEnum,
  readFields, readList, readNumber, readOption, readOutputReference, variantIndex, writeBigInt, writeBytes,
  writeList, writeNumber, writeOption, writeOutputReference,
} from "./plutus-schema.js";

export type Delegator =
  | { type: "PrincipalKey"; hash: string; organisation: string | null }
  | { type: "Agent"; id: string };

export interface ValueLimit {
  perTx: bigint;
  total: bigint;
  periodMs: number;
}

export interface DelegationDatum {
  delegator: Delegator;
  parent: string | null;
  delegate: string;
  delegateKey: string;
  actions: string[];
  resources: string[];
  notBefore: number;
  notAfter: number;
  depth: number;
  remaining: number;
  purpose: string | null;
  value: ValueLimit | null;
}

export type DelegationMint = { type: "Delegate"; seed: OutputReference } | { type: "Undelegate" };

export type VaultDatum =
  | { type: "Live"; owner: Delegator; delegation: string; spent: bigint; periodStart: number }
  /** An escrow refund. Only Close spends it. */
  | { type: "Returned"; owner: Delegator };

export type VaultSpend = { type: "Pay" } | { type: "Close" };

const DELEGATORS = ["PrincipalKey", "Agent"] as const;
const MINTS = ["Delegate", "Undelegate"] as const;
const VAULT_DATUMS = ["Live", "Returned"] as const;
const VAULT_SPENDS = ["Pay", "Close"] as const;
const HASH28 = 28;
const BYTES32 = 32;

function bytes32(value: string, path: string): PlutusData {
  return writeBytes(value, path, BYTES32);
}

function readBytes32(data: PlutusData, path: string): string {
  return readBytes(data, path, BYTES32);
}

// ─── Delegator ───────────────────────────────────────────────────────

export function delegatorToData(value: Delegator, path: string): PlutusData {
  const index = variantIndex(value, DELEGATORS, path);
  if (value.type === "Agent") return constr(index, [bytes32(value.id, at(path, "id"))]);
  return constr(index, [
    writeBytes(value.hash, at(path, "hash"), HASH28),
    writeOption(value.organisation, at(path, "organisation"), writeBytes),
  ]);
}

export function delegatorFromData(data: PlutusData, path: string): Delegator {
  const { index } = readConstr(data, path, DELEGATORS.length);
  if (index === 1) {
    const [id] = readFields(data, path, 1, 1);
    return { type: "Agent", id: readBytes32(id!, at(path, "id")) };
  }
  const [hash, organisation] = readFields(data, path, 0, 2);
  return {
    type: "PrincipalKey",
    hash: readBytes(hash!, at(path, "hash"), HASH28),
    organisation: readOption(organisation!, at(path, "organisation"), readBytes),
  };
}

// ─── DelegationDatum ─────────────────────────────────────────────────

function valueLimitToData(value: ValueLimit, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a value limit");
  return constr(0, [
    writeBigInt(value.perTx, at(path, "perTx")),
    writeBigInt(value.total, at(path, "total")),
    writeNumber(value.periodMs, at(path, "periodMs")),
  ]);
}

function valueLimitFromData(data: PlutusData, path: string): ValueLimit {
  const [perTx, total, periodMs] = readFields(data, path, 0, 3);
  return {
    perTx: readBigInt(perTx!, at(path, "perTx")),
    total: readBigInt(total!, at(path, "total")),
    periodMs: readNumber(periodMs!, at(path, "periodMs")),
  };
}

export function delegationDatumToData(value: DelegationDatum, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected a delegation datum");
  return constr(0, [
    delegatorToData(value.delegator, at(path, "delegator")),
    writeOption(value.parent, at(path, "parent"), bytes32),
    bytes32(value.delegate, at(path, "delegate")),
    writeBytes(value.delegateKey, at(path, "delegateKey"), HASH28),
    writeList(value.actions, at(path, "actions"), writeBytes),
    writeList(value.resources, at(path, "resources"), writeBytes),
    writeNumber(value.notBefore, at(path, "notBefore")),
    writeNumber(value.notAfter, at(path, "notAfter")),
    writeNumber(value.depth, at(path, "depth")),
    writeNumber(value.remaining, at(path, "remaining")),
    writeOption(value.purpose, at(path, "purpose"), bytes32),
    writeOption(value.value, at(path, "value"), valueLimitToData),
  ]);
}

export function delegationDatumFromData(data: PlutusData, path = ""): DelegationDatum {
  const f = readFields(data, path, 0, 12);
  return {
    delegator: delegatorFromData(f[0]!, at(path, "delegator")),
    parent: readOption(f[1]!, at(path, "parent"), readBytes32),
    delegate: readBytes32(f[2]!, at(path, "delegate")),
    delegateKey: readBytes(f[3]!, at(path, "delegateKey"), HASH28),
    actions: readList(f[4]!, at(path, "actions"), readBytes),
    resources: readList(f[5]!, at(path, "resources"), readBytes),
    notBefore: readNumber(f[6]!, at(path, "notBefore")),
    notAfter: readNumber(f[7]!, at(path, "notAfter")),
    depth: readNumber(f[8]!, at(path, "depth")),
    remaining: readNumber(f[9]!, at(path, "remaining")),
    purpose: readOption(f[10]!, at(path, "purpose"), readBytes32),
    value: readOption(f[11]!, at(path, "value"), valueLimitFromData),
  };
}

export function delegationMintToData(value: DelegationMint, path = ""): PlutusData {
  const index = variantIndex(value, MINTS, path);
  return value.type === "Delegate" ? constr(index, [writeOutputReference(value.seed, at(path, "seed"))]) : constr(index, []);
}

export function delegationMintFromData(data: PlutusData, path = ""): DelegationMint {
  const { index } = readConstr(data, path, MINTS.length);
  if (index === 1) {
    readFields(data, path, 1, 0);
    return { type: "Undelegate" };
  }
  const [seed] = readFields(data, path, 0, 1);
  return { type: "Delegate", seed: readOutputReference(seed!, at(path, "seed")) };
}

// ─── Vault ───────────────────────────────────────────────────────────

export function vaultDatumToData(value: VaultDatum, path = ""): PlutusData {
  const index = variantIndex(value, VAULT_DATUMS, path);
  const owner = delegatorToData(value.owner, at(path, "owner"));
  if (value.type === "Returned") return constr(index, [owner]);
  return constr(index, [
    owner,
    bytes32(value.delegation, at(path, "delegation")),
    writeBigInt(value.spent, at(path, "spent")),
    writeNumber(value.periodStart, at(path, "periodStart")),
  ]);
}

export function vaultDatumFromData(data: PlutusData, path = ""): VaultDatum {
  const { index } = readConstr(data, path, VAULT_DATUMS.length);
  if (index === 1) {
    const [owner] = readFields(data, path, 1, 1);
    return { type: "Returned", owner: delegatorFromData(owner!, at(path, "owner")) };
  }
  const [owner, delegation, spent, periodStart] = readFields(data, path, 0, 4);
  return {
    type: "Live",
    owner: delegatorFromData(owner!, at(path, "owner")),
    delegation: readBytes32(delegation!, at(path, "delegation")),
    spent: readBigInt(spent!, at(path, "spent")),
    periodStart: readNumber(periodStart!, at(path, "periodStart")),
  };
}

// ─── Hex codecs ──────────────────────────────────────────────────────

export function encodeDelegationDatum(value: DelegationDatum): string {
  return codec("encodeDelegationDatum", () => encodePlutusDataHex(delegationDatumToData(value)));
}

export function decodeDelegationDatum(hex: string): DelegationDatum {
  return codec("decodeDelegationDatum", () => delegationDatumFromData(decodeHexData(hex)));
}

export function encodeDelegationMint(value: DelegationMint): string {
  return codec("encodeDelegationMint", () => encodePlutusDataHex(delegationMintToData(value)));
}

export function decodeDelegationMint(hex: string): DelegationMint {
  return codec("decodeDelegationMint", () => delegationMintFromData(decodeHexData(hex)));
}

export function encodeVaultDatum(value: VaultDatum): string {
  return codec("encodeVaultDatum", () => encodePlutusDataHex(vaultDatumToData(value)));
}

export function decodeVaultDatum(hex: string): VaultDatum {
  return codec("decodeVaultDatum", () => vaultDatumFromData(decodeHexData(hex)));
}

export function encodeVaultSpend(value: VaultSpend): string {
  return codec("encodeVaultSpend", () => {
    const index = variantIndex(value, VAULT_SPENDS, "");
    return encodePlutusDataHex(constr(index, []));
  });
}

export function decodeVaultSpend(hex: string): VaultSpend {
  return codec("decodeVaultSpend", () => ({ type: readEnum(decodeHexData(hex), "", VAULT_SPENDS) }));
}
