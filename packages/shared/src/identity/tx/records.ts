/**
 * Off-chain copies of the identity rules that the builders check before they
 * build: authentic records and the configuration record, the valid datum
 * (Part 2 §3.3), `effective`, `active_key` and the party predicates of §3.2.
 * They follow `contracts/identity-marketplace/lib/vector_identity.ak` and
 * `lib/identity_marketplace/identity/{datum,rules}.ak`.
 */

import type { Utxo } from "../../chain/ChainProvider.js";
import {
  decodeIdentityDatum, type IdentityDatum, type Party, type Signer,
} from "../../cbor/IdentityDatum.js";
import { decodePlutusDataHex } from "../../cbor/plutus-data.js";
import {
  CAPABILITY_MAX_BYTES, DAYS_30_MS, DESCRIPTION_MAX_BYTES, ENDPOINT_MAX_BYTES, FRAMEWORK_MAX_BYTES, MAX_CAPABILITIES,
  MAX_DEPTH, MAX_HOLDS, MAX_KEYS, MAX_PARTIES, MAX_RECORD_INT, MAX_TIME_MS, NAME_MAX_BYTES, ORGANISATION_MAX_BYTES,
  PURPOSE_ASSERTION, PURPOSE_AUTHENTICATION, PURPOSE_DELEGATION, PURPOSE_TRANSACTION, RIGHT_RECOVER, ROLE_MAX_RIGHTS,
} from "../constants.js";
import { keyHash } from "../id.js";
import { isEnterpriseAddressOf, utxoAssets } from "./ledger.js";
import { refuse } from "./types.js";

/** UTF-8 `identity-config`: the asset name of the configuration token (Part 2 §3.8). */
export const CONFIG_TOKEN_NAME = "6964656e746974792d636f6e666967";

/** An authentic record: the UTxO, its identifier and its datum. */
export interface RecordUtxo {
  utxo: Utxo;
  id: string;
  datum: IdentityDatum;
}

/**
 * Reads an authentic record (`find_record`): an output at exactly the
 * identity address that holds exactly one token of the identity policy (the
 * identifier, quantity 1) and an inline datum that decodes as IdentityDatum.
 * Live records and tombstones count.
 */
export function readRecord(utxo: Utxo, identityHash: string, label = "record"): RecordUtxo {
  const where = `${label} ${utxo.ref.txHash}#${utxo.ref.index}`;
  if (!isEnterpriseAddressOf(utxo.address, { type: "Script", hash: identityHash })) {
    refuse("record_not_authentic", `${where} is not at the identity address`);
  }
  const tokens = utxoAssets(utxo).filter((a) => a.policy === identityHash);
  if (tokens.length !== 1 || tokens[0]!.quantity !== 1n) {
    refuse("record_not_authentic", `${where} does not hold exactly one identity token`);
  }
  if (utxo.datumHex === null) refuse("record_not_authentic", `${where} has no inline datum`);
  let datum: IdentityDatum;
  try {
    datum = decodeIdentityDatum(utxo.datumHex);
  } catch (error) {
    return refuse("record_datum_invalid", `${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { utxo, id: tokens[0]!.name, datum };
}

/**
 * M1 of the configuration record (Part 2 §3.2): the 28-byte inline datum of
 * the UTxO at exactly the `config_holder` address that holds the
 * configuration token.
 */
export function readConfigRecord(utxo: Utxo, configPolicy: string, configHolder: string): string {
  const where = `configuration record ${utxo.ref.txHash}#${utxo.ref.index}`;
  if (!isEnterpriseAddressOf(utxo.address, { type: "Script", hash: configHolder })) {
    refuse("config_not_authentic", `${where} is not at the config_holder address`);
  }
  if (utxoAssets(utxo).find((a) => a.policy === configPolicy && a.name === CONFIG_TOKEN_NAME)?.quantity !== 1n) {
    refuse("config_not_authentic", `${where} does not hold the configuration token`);
  }
  const datum = utxo.datumHex === null ? null : decodePlutusDataHex(utxo.datumHex);
  if (datum === null || datum.kind !== "bytes" || datum.hex.length !== 56) {
    refuse("config_not_authentic", `${where} has no 28-byte inline datum`);
  }
  return datum.hex;
}

// ─── §3.2 predicates ─────────────────────────────────────────────────

export const hasRight = (rights: number, right: number): boolean => Math.floor(rights / right) % 2 === 1;

const notEnded = (party: Party, hi: number): boolean => party.notAfter === null || party.notAfter >= hi;

/** `covers(p)`: `not_before ≤ lo`, and `not_after` is empty or `≥ hi`. */
export const covers = (party: Party, lo: number, hi: number): boolean => party.notBefore <= lo && notEnded(party, hi);

/** `accountable(D)`: some Accountable party covers [lo, hi]. */
export const accountable = (record: IdentityDatum, lo: number, hi: number): boolean =>
  record.parties.some((p) => p.role === "Accountable" && covers(p, lo, hi));

/** The guardian bound: the threshold is at most the Guardian parties with the recover right whose `not_after` is empty or `≥ hi`. */
export const guardianBound = (record: IdentityDatum, hi: number): boolean =>
  record.guardianThreshold
    <= record.parties.filter((p) => p.role === "Guardian" && hasRight(p.rights, RIGHT_RECOVER) && notEnded(p, hi)).length;

export function sameSigner(a: Signer, b: Signer): boolean {
  if (a.type === "ControllerSet" || b.type === "ControllerSet") return a.type === b.type;
  return a.type === b.type && a.hash === b.hash;
}

export const sameParty = (a: Party, b: Party): boolean => a.role === b.role && sameSigner(a.signer, b.signer);

export const terminal = (record: IdentityDatum): boolean =>
  record.status.type === "Revoked" || record.status.type === "Retired";

/** True when `party` equals `other` field by field. */
export function partyEquals(a: Party, b: Party): boolean {
  return a.role === b.role && sameSigner(a.signer, b.signer) && a.organisation === b.organisation
    && a.notBefore === b.notBefore && a.notAfter === b.notAfter && a.rights === b.rights && a.removalAfter === b.removalAfter;
}

/** `active_key`: a listed key with this key hash and purpose. Purposes 8 and 16 count only for Ed25519. */
export function activeKey(record: IdentityDatum, keyHashHex: string, purpose: number): boolean {
  if (![PURPOSE_AUTHENTICATION, PURPOSE_ASSERTION, PURPOSE_TRANSACTION, PURPOSE_DELEGATION].includes(purpose)) return false;
  return record.keys.some((key) => {
    if ((purpose === PURPOSE_TRANSACTION || purpose === PURPOSE_DELEGATION) && key.keyType !== "Ed25519") return false;
    return hasRight(key.purposes, purpose) && keyHash(key.key) === keyHashHex;
  });
}

// ─── Effective status ────────────────────────────────────────────────

export type EffectiveStatus = "Active" | "Suspended" | "Revoked" | "Retired";

/**
 * `effective(record, refs, identity_hash, lo, hi)` with the ancestors in
 * `ancestors` (by identifier). Refuses when an ancestor is missing, as the
 * contract fails then.
 */
export function effectiveStatus(
  record: IdentityDatum,
  ancestors: ReadonlyMap<string, IdentityDatum>,
  lo: number,
  hi: number,
  left = MAX_DEPTH,
): EffectiveStatus {
  if (record.status.type === "Revoked" || record.status.type === "Retired") return record.status.type;
  let inherited: EffectiveStatus = "Active";
  if (record.lineage.type === "Subagent") {
    const parent = ancestors.get(record.lineage.parent);
    if (left <= 0) refuse("ancestors_too_deep", "the record has more than 4 ancestors");
    if (parent === undefined) refuse("ancestor_missing", `the record of ancestor ${record.lineage.parent} is missing (a reference input is needed)`);
    inherited = parent.subagentEpoch > record.lineage.parentEpoch ? "Revoked" : effectiveStatus(parent, ancestors, lo, hi, left - 1);
  }
  if (inherited !== "Active") return inherited;
  if (record.status.type === "Suspended" && record.status.holds.some((h) => h.until > lo)) return "Suspended";
  return accountable(record, lo, hi) ? "Active" : "Suspended";
}

/**
 * The records that `effective` reads for `record`: its parent, the parent's
 * parent and so on. Refuses when one is missing from `available`.
 */
export function ancestorChain(record: IdentityDatum, available: ReadonlyMap<string, RecordUtxo>): RecordUtxo[] {
  const chain: RecordUtxo[] = [];
  let current = record;
  while (current.lineage.type === "Subagent") {
    if (chain.length >= MAX_DEPTH) refuse("ancestors_too_deep", "the record has more than 4 ancestors");
    const parent = available.get(current.lineage.parent);
    if (parent === undefined) refuse("ancestor_missing", `the record of ancestor ${current.lineage.parent} is missing (a reference input is needed)`);
    chain.push(parent);
    current = parent.datum;
  }
  return chain;
}

/** Index records by identifier. */
export function recordMap(records: readonly RecordUtxo[]): Map<string, RecordUtxo> {
  return new Map(records.map((r) => [r.id, r]));
}

export function datumMap(records: readonly RecordUtxo[]): Map<string, IdentityDatum> {
  return new Map(records.map((r) => [r.id, r.datum]));
}

// ─── Valid datum (§3.3) ──────────────────────────────────────────────

const byteLength = (hex: string): number => hex.length / 2;
const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME_MS;
const validUint = (n: number): boolean => Number.isSafeInteger(n) && n >= 0 && BigInt(n) <= MAX_RECORD_INT;

function signerProblems(signer: Signer, path: string): string[] {
  if (signer.type === "ControllerSet") return [];
  return byteLength(signer.hash) === 28 ? [] : [`${path}: a signer hash has 28 bytes`];
}

/**
 * The reasons why `record` is not a valid datum (§3.3); empty when it is.
 * `m1` is the Module-1 hash of the configuration record, or null when the
 * transaction has no configuration reference input.
 */
export function datumProblems(record: IdentityDatum, m1: string | null): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  check(byteLength(record.controller) === 32, "controller: an Ed25519 key has 32 bytes");
  check(record.keys.length <= MAX_KEYS, `keys: at most ${MAX_KEYS}`);
  record.keys.forEach((key, i) => {
    const path = `keys[${i}]`;
    if (key.keyType === "Ed25519") {
      check(byteLength(key.key) === 32, `${path}: an Ed25519 key has 32 bytes`);
      check(key.pop === null, `${path}: an Ed25519 key has no pop`);
      check(key.purposes >= 1 && key.purposes <= 27 && Math.floor(key.purposes / 4) % 2 === 0, `${path}: purposes must be a sum of 1, 2, 8 and 16`);
    } else {
      check(byteLength(key.key) === 33, `${path}: a P-256 key has 33 bytes`);
      check(key.pop !== null && byteLength(key.pop) === 64, `${path}: a P-256 key needs a 64-byte pop`);
      check(key.purposes >= 1 && key.purposes <= 3, `${path}: P-256 purposes must be a sum of 1 and 2`);
    }
    check(!record.keys.slice(i + 1).some((other) => other.key === key.key), `${path}: the key is listed twice`);
  });
  check(record.parties.length <= MAX_PARTIES, `parties: at most ${MAX_PARTIES}`);
  record.parties.forEach((party, i) => {
    const path = `parties[${i}]`;
    check(
      Number.isSafeInteger(party.rights) && party.rights >= 0 && party.rights <= 7 && (party.rights & ~ROLE_MAX_RIGHTS[party.role]) === 0,
      `${path}: rights ${party.rights} exceed the ${party.role} role`,
    );
    if (party.signer.type === "KeyHash") check(byteLength(party.signer.hash) === 28, `${path}: a key hash has 28 bytes`);
    if (party.signer.type === "Script") {
      check(party.role === "Accountable" || party.role === "Responsible", `${path}: only an Accountable or Responsible party can be Module-1`);
      check(m1 !== null, `${path}: a Script party needs the configuration reference input`);
      check(m1 === null || party.signer.hash === m1, `${path}: a Script party must be Module-1 (${m1})`);
    }
    if (party.signer.type === "ControllerSet") {
      check(party.role === "Accountable" || party.role === "Responsible", `${path}: only an Accountable or Responsible party can be ControllerSet`);
    }
    check(party.organisation === null || (byteLength(party.organisation) >= 1 && byteLength(party.organisation) <= ORGANISATION_MAX_BYTES), `${path}: organisation has 1..64 bytes`);
    check(validTime(party.notBefore), `${path}: not_before is not a valid time`);
    check(party.notAfter === null || (validTime(party.notAfter) && party.notAfter > party.notBefore), `${path}: not_after must be after not_before`);
    check(party.removalAfter === null || validTime(party.removalAfter), `${path}: removal_after is not a valid time`);
    check(!record.parties.slice(i + 1).some((other) => sameParty(other, party)), `${path}: two parties have the same role and signer`);
  });
  check(validUint(record.guardianThreshold), "guardian_threshold is not a valid integer");
  if (record.pendingRecovery !== null) {
    check(record.guardianThreshold >= 1, "pending_recovery needs a guardian threshold of at least 1");
    check(byteLength(record.pendingRecovery.newController) === 32, "pending_recovery: the new controller has 32 bytes");
    check(validTime(record.pendingRecovery.effectiveAfter), "pending_recovery: effective_after is not a valid time");
  }
  if (record.lineage.type === "Subagent") {
    check(byteLength(record.lineage.parent) === 32, "lineage: the parent identifier has 32 bytes");
    check(validUint(record.lineage.parentEpoch), "lineage: parent_epoch is not a valid integer");
    check(record.lineage.depth >= 1 && record.lineage.depth <= MAX_DEPTH, "lineage: depth is 1..4");
    check(record.endpoint === "", "endpoint: a subagent has an empty endpoint");
  } else {
    check(byteLength(record.endpoint) <= ENDPOINT_MAX_BYTES, `endpoint: at most ${ENDPOINT_MAX_BYTES} bytes`);
  }
  check(validUint(record.subagentEpoch), "subagent_epoch is not a valid integer");
  check(byteLength(record.name) >= 1 && byteLength(record.name) <= NAME_MAX_BYTES, `name: 1..${NAME_MAX_BYTES} bytes`);
  check(byteLength(record.description) <= DESCRIPTION_MAX_BYTES, `description: at most ${DESCRIPTION_MAX_BYTES} bytes`);
  check(byteLength(record.framework) <= FRAMEWORK_MAX_BYTES, `framework: at most ${FRAMEWORK_MAX_BYTES} bytes`);
  check(record.capabilities.length <= MAX_CAPABILITIES, `capabilities: at most ${MAX_CAPABILITIES}`);
  record.capabilities.forEach((capability, i) => {
    check(byteLength(capability) >= 1 && byteLength(capability) <= CAPABILITY_MAX_BYTES, `capabilities[${i}]: 1..${CAPABILITY_MAX_BYTES} bytes`);
    check(!record.capabilities.slice(i + 1).includes(capability), `capabilities[${i}]: listed twice`);
  });
  check(validTime(record.createdAt), "created_at is not a valid time");
  const status = record.status;
  if (status.type === "Suspended") {
    check(status.holds.length >= 1 && status.holds.length <= MAX_HOLDS, `status: 1..${MAX_HOLDS} holds`);
    status.holds.forEach((hold, i) => {
      const path = `status.holds[${i}]`;
      problems.push(...signerProblems(hold.by, path));
      check(validUint(hold.reason) && validTime(hold.since) && validTime(hold.until), `${path}: invalid reason or times`);
      check(hold.since < hold.until && hold.until - hold.since <= DAYS_30_MS, `${path}: a hold lasts at most 30 days`);
      check(!status.holds.slice(i + 1).some((other) => sameSigner(other.by, hold.by)), `${path}: two holds have the same author`);
    });
  }
  if (status.type === "Revoked" || status.type === "Retired") {
    check(
      record.keys.length === 0 && record.parties.length === 0 && record.guardianThreshold === 0 && record.pendingRecovery === null
        && record.description === "" && record.framework === "" && record.endpoint === "" && record.capabilities.length === 0,
      "status: a terminal record must be a tombstone",
    );
    check(validTime(status.at), "status: at is not a valid time");
    check(status.successor === null || byteLength(status.successor) === 32, "status: a successor has 32 bytes");
    if (status.type === "Revoked") {
      problems.push(...signerProblems(status.by, "status.by"));
      check(validUint(status.reason), "status: reason is not a valid integer");
      check(status.invalidFrom === null || validTime(status.invalidFrom), "status: invalid_from is not a valid time");
    }
  }
  return problems;
}

/** Refuses a datum that is not valid (§3.3), with every reason. */
export function requireValidDatum(record: IdentityDatum, m1: string | null, label: string): void {
  const problems = datumProblems(record, m1);
  if (problems.length > 0) refuse("datum_invalid", `${label} is not a valid record: ${problems.join("; ")}`);
}

/** True when the record has a Module-1 (`Script`) party. Such a record output needs the configuration reference input. */
export const hasScriptParty = (record: IdentityDatum): boolean => record.parties.some((p) => p.signer.type === "Script");
