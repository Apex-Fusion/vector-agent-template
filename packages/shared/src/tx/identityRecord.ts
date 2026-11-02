/**
 * tx/identityRecord.ts — the identity checks of the escrow and advert
 * builders: Claim and Submit (Part 2 §6.1), RefundRevoked (§6.1) and the
 * listing rule (§6.2).
 *
 * The caller passes a record lookup. The builders check the output that it
 * returns as the escrow contract does, with the rules of `vector_identity`
 * (Part 2 §3.10): `find_record` (an authentic record, Part 1 §4),
 * `independent`, `effective`, `active_key` and `has_capability`. The new
 * escrow accepts only records without a parent for Claim and Submit, so
 * `effective` here covers a record without a parent: no ancestor is read.
 */

import type { OutputReference, Utxo } from "../chain/ChainProvider.js";
import { decodeIdentityDatum, type IdentityDatum, type Key } from "../cbor/IdentityDatum.js";
import { plutusAddressFromBech32 } from "../cbor/address.js";
import { keyHash, utf8ToHex } from "../identity/id.js";
import {
  PURPOSE_ASSERTION, PURPOSE_AUTHENTICATION, PURPOSE_DELEGATION, PURPOSE_TRANSACTION,
} from "../identity/constants.js";
import { TxConstructionError } from "./types.js";

/**
 * Finds the current record output of `agentId` (64 lowercase hex) at the
 * identity address, or null. The builder checks the output it gets.
 */
export type RecordLookup = (agentId: string) => Promise<Utxo | null>;

/**
 * The required signers (28-byte key hashes, lowercase hex) of the transaction
 * that created the advert output `advertRef`, or null when unknown. The
 * listing rule (§6.2) needs `supplier_pkh` among them.
 */
export type AdvertSignersLookup = (advertRef: OutputReference) => Promise<readonly string[] | null>;

/** Effective status of `vector_identity.effective` (Part 2 §3.10). */
export type EffectiveStatus = "Active" | "Suspended" | "Revoked" | "Retired";

/** What an agent must satisfy to work through the new escrow (§6.1 Claim/Submit, §6.2 listing rule). */
export interface AgentWorkCheck {
  /** The supplier key hash: a listed Ed25519 key with the transaction purpose. */
  keyHash: string;
  /** UTF-8 capability id; omitted for Submit, which does not check it. */
  capabilityId?: string;
  /** The window [lo, hi] over which the record must be effectively Active. */
  lo: number;
  hi: number;
}

/**
 * The record of `agentId` in `utxo`, checked as `find_record` does: the exact
 * identity address (Script(identityHash), no stake credential), exactly one
 * token of the identity policy, named `agentId`, quantity 1, and an inline
 * datum that decodes as an identity record. Throws TxConstructionError
 * "agent record not found" or "agent record not authentic".
 */
export function readAgentRecord(utxo: Utxo | null, identityHash: string, agentId: string): IdentityDatum {
  if (utxo === null) {
    throw new TxConstructionError("agent record not found", `no record output for agent ${agentId}`);
  }
  const where = `${utxo.ref.txHash}#${utxo.ref.index}`;
  let address;
  try {
    address = plutusAddressFromBech32(utxo.address);
  } catch {
    throw new TxConstructionError("agent record not authentic", `${where}: address ${utxo.address} is not a Shelley address`);
  }
  if (
    address.paymentCredential.type !== "Script" ||
    address.paymentCredential.hash !== identityHash ||
    address.stakeCredential !== null
  ) {
    throw new TxConstructionError("agent record not authentic", `${where}: not at the identity address`);
  }
  // Units are policy ID + asset name; the Ogmios chain providers write "policy.name", lucid "policyname".
  const tokens = Object.entries(utxo.assets)
    .map(([unit, quantity]) => [unit.toLowerCase().replace(".", ""), quantity] as const)
    .filter(([unit]) => unit.startsWith(identityHash));
  const [token] = tokens;
  if (tokens.length !== 1 || token![0] !== identityHash + agentId || token![1] !== 1n) {
    throw new TxConstructionError(
      "agent record not authentic",
      `${where}: expected exactly one token ${identityHash}.${agentId}`,
    );
  }
  if (!utxo.datumHex) {
    throw new TxConstructionError("agent record not authentic", `${where}: no inline datum`);
  }
  try {
    return decodeIdentityDatum(utxo.datumHex);
  } catch (err) {
    throw new TxConstructionError("agent record not authentic", `${where}: ${(err as Error).message}`);
  }
}

/**
 * `effective(record)` over [lo, hi] for a record without a parent: a
 * tombstone gives its status; a hold with `until > lo` gives Suspended; no
 * Accountable Party that covers [lo, hi] gives Suspended; else Active.
 * Throws for a subagent, whose status also depends on its ancestors.
 */
export function rootEffectiveStatus(record: IdentityDatum, lo: number, hi: number): EffectiveStatus {
  if (record.lineage.type !== "Root") {
    throw new Error("rootEffectiveStatus: the record has a parent");
  }
  const status = record.status;
  if (status.type === "Revoked" || status.type === "Retired") return status.type;
  if (status.type === "Suspended" && status.holds.some((hold) => hold.until > lo)) return "Suspended";
  const accountable = record.parties.some((party) =>
    party.role === "Accountable" && party.notBefore <= lo && (party.notAfter === null || party.notAfter >= hi));
  return accountable ? "Active" : "Suspended";
}

/**
 * `key_has_purpose`: `purpose` is one purpose value; the transaction and
 * delegation purposes count only for Ed25519 keys.
 */
function keyHasPurpose(key: Key, purpose: number): boolean {
  const allowed = purpose === PURPOSE_AUTHENTICATION || purpose === PURPOSE_ASSERTION
    ? true
    : (purpose === PURPOSE_TRANSACTION || purpose === PURPOSE_DELEGATION) && key.keyType === "Ed25519";
  return allowed && Math.floor(key.purposes / purpose) % 2 === 1;
}

/** `active_key(record, keyHash, purpose)`: a listed key with this hash and purpose. */
export function recordHasKey(record: IdentityDatum, keyHashHex: string, purpose: number): boolean {
  return record.keys.some((key) => keyHasPurpose(key, purpose) && keyHash(key.key) === keyHashHex);
}

/**
 * The first rule of `check` that the record breaks, as a TxConstructionError
 * reason, or null when it passes: "agent not independent", "agent not
 * active", "supplier key not listed", "capability not listed".
 */
export function agentWorkProblem(record: IdentityDatum, check: AgentWorkCheck): string | null {
  if (record.lineage.type !== "Root") return "agent not independent";
  if (rootEffectiveStatus(record, check.lo, check.hi) !== "Active") return "agent not active";
  if (!recordHasKey(record, check.keyHash, PURPOSE_TRANSACTION)) return "supplier key not listed";
  if (check.capabilityId !== undefined && !record.capabilities.includes(utf8ToHex(check.capabilityId))) {
    return "capability not listed";
  }
  return null;
}

/** Throws TxConstructionError with the reason of agentWorkProblem. */
export function assertAgentCanWork(record: IdentityDatum, agentId: string, check: AgentWorkCheck): void {
  const problem = agentWorkProblem(record, check);
  if (problem !== null) {
    const status = record.lineage.type === "Root" ? rootEffectiveStatus(record, check.lo, check.hi) : "subagent";
    throw new TxConstructionError(problem, `agent ${agentId} (${status} over [${check.lo}, ${check.hi}]): ${problem}`);
  }
}
