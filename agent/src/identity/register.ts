/**
 * supplier/src/identity/register.ts — the identity record of a supplier key
 * (Part 2 §9.2) and its Register transaction (§3.4).
 *
 * Each supplier key that we run gets one native record:
 * - controller: the Foundation operator key (its private key stays offline);
 * - Accountable Party: the controller (`ControllerSet`), or a configured key hash;
 * - listed key: the supplier key, with the authentication and transaction purposes;
 * - capabilities: the `capability_id` values of that key's adverts.
 *
 * Register needs the signatures of the controller, of each listed Ed25519
 * key, of each party and of the wallet inputs (§3.4 rules 7–8). The supplier
 * key funds the deposit and signs first; the transaction then goes to the
 * other signers (the offline controller) as a registration file; the last
 * step checks that every signer signed and submits it.
 *
 * The Register builder itself is the identity-family builder of the shared
 * package (buildRegister); registrar.ts wraps it as a RecordRegistrar.
 */

import { activeKey } from "@marketplace/shared";
import type { ChainProvider } from "@marketplace/shared/chain";
import type { Key, Party, Signer } from "@marketplace/shared/cbor";
import {
  CAPABILITY_MAX_BYTES, DESCRIPTION_MAX_BYTES, ENDPOINT_MAX_BYTES, MAX_CAPABILITIES, MAX_RANGE_MS, NAME_MAX_BYTES,
  PURPOSE_AUTHENTICATION, PURPOSE_TRANSACTION, ROLE_MAX_RIGHTS, keyHash, vectorDid,
} from "@marketplace/shared/identity";
import { readAgentRecord, type IdentityBlueprint, type WalletKey } from "@marketplace/shared/tx";
import { decodeAdvert } from "./agent.js";

/** The listed supplier key's purposes: authentication + transaction (§9.2). */
export const SUPPLIER_KEY_PURPOSES = PURPOSE_AUTHENTICATION | PURPOSE_TRANSACTION;

/** Profile text of a new record (Part 1 §5 limits). */
export interface RecordProfile {
  name: string;
  description: string;
  endpoint: string;
  capabilities: string[];
}

/** The validity window [lo, hi] of the Register transaction, POSIX ms, slot starts. */
export interface RegisterWindow {
  lo: number;
  hi: number;
}

/** Everything the Register builder needs for one supplier record. */
export interface RegisterRecordArgs {
  /** The supplier wallet: it funds the record deposit (max of 10 AP3X and the ledger minimum) and the fee; one of its key-locked UTxOs is the seed. */
  wallet: WalletKey;
  /** The controller's Ed25519 public key (32 bytes, hex). */
  controller: string;
  keys: Key[];
  parties: Party[];
  profile: RecordProfile;
  window: RegisterWindow;
}

/** A built, unsigned Register transaction. */
export interface RegisterRecordTx {
  txCborHex: string;
  /** The transaction ID (blake2b-256 of the body). */
  txHash: string;
  /** The new identifier (64 lowercase hex). */
  agentId: string;
  /** Every key hash that must sign, sorted. */
  requiredSigners: string[];
}

/** The witness helpers of a built transaction (shared package: signTransaction, transactionId). */
export interface TransactionWitnesses {
  /** Adds the Ed25519 witness of `privateKeyHex` over the transaction ID and keeps the other witnesses. */
  sign(txCborHex: string, privateKeyHex: string): Promise<string>;
  /** The transaction ID of a transaction in CBOR hex. */
  txId(txCborHex: string): string;
}

/** The identity-family Register builder (shared package: buildRegister) and the witness helpers. */
export interface RecordRegistrar extends TransactionWitnesses {
  build(args: RegisterRecordArgs): Promise<RegisterRecordTx>;
}

/** The registration that travels between the signers: written by build, updated by sign, read by submit. */
export interface RegistrationFile {
  version: 1;
  network_id: 0 | 1;
  agent_id: string;
  agent_did: string;
  tx_hash: string;
  tx_cbor: string;
  required_signers: string[];
  signed_by: string[];
  /** The upper validity bound: submit before it. */
  valid_until_ms: number;
  record: {
    controller: string;
    accountable: Signer;
    supplier_key: string;
    name: string;
    endpoint: string;
    capabilities: string[];
  };
}

/** IDENTITY_ACCOUNTABLE_PARTY: "controller" (default, ControllerSet) or a 56-hex key hash. */
export function parseAccountableParty(value: string | undefined): Signer {
  if (value === undefined || value === "" || value === "controller") return { type: "ControllerSet" };
  if (!/^[0-9a-f]{56}$/.test(value)) {
    throw new Error('IDENTITY_ACCOUNTABLE_PARTY must be "controller" or a 56-character lowercase hex key hash');
  }
  return { type: "KeyHash", hash: value };
}

/** IDENTITY_CONTROLLER_PUB_KEY_HEX: the controller's 32-byte Ed25519 public key. */
export function parseControllerKey(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("IDENTITY_CONTROLLER_PUB_KEY_HEX must be 64 lowercase hex characters (an Ed25519 public key)");
  }
  return value;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * The Register window: one hour from 60 s before `nowMs` (Part 2 §3.2:
 * hi − lo ≤ 3,600,000). The offline signers have the whole hour. Vector slots
 * are one second long and start on whole seconds.
 */
export function registerWindow(nowMs: number): RegisterWindow {
  const lo = Math.floor((nowMs - 60_000) / 1000) * 1000;
  return { lo, hi: lo + MAX_RANGE_MS };
}

/**
 * The §9.2 record of a supplier key: the controller, one Accountable Party
 * from the window start without end, the supplier key with purposes 9, and
 * the profile. Throws when a profile value breaks a Part 1 §5 limit.
 */
export function supplierRecord(args: {
  controller: string;
  accountable: Signer;
  supplierPubKeyHex: string;
  profile: RecordProfile;
  window: RegisterWindow;
}): Pick<RegisterRecordArgs, "controller" | "keys" | "parties" | "profile"> {
  const { profile } = args;
  const nameBytes = utf8Length(profile.name);
  if (nameBytes < 1 || nameBytes > NAME_MAX_BYTES) throw new Error(`record name must have 1-${NAME_MAX_BYTES} bytes`);
  if (utf8Length(profile.description) > DESCRIPTION_MAX_BYTES) {
    throw new Error(`record description must have at most ${DESCRIPTION_MAX_BYTES} bytes`);
  }
  if (utf8Length(profile.endpoint) > ENDPOINT_MAX_BYTES) throw new Error(`record endpoint must have at most ${ENDPOINT_MAX_BYTES} bytes`);
  if (profile.capabilities.length === 0 || profile.capabilities.length > MAX_CAPABILITIES) {
    throw new Error(`a supplier record needs 1-${MAX_CAPABILITIES} capabilities`);
  }
  for (const capability of profile.capabilities) {
    const bytes = utf8Length(capability);
    if (bytes < 1 || bytes > CAPABILITY_MAX_BYTES) throw new Error(`capability ${capability} must have 1-${CAPABILITY_MAX_BYTES} bytes`);
  }
  if (new Set(profile.capabilities).size !== profile.capabilities.length) throw new Error("record capabilities must be distinct");
  if (args.accountable.type === "Script") throw new Error("a supplier record's Accountable Party is the controller or a key");
  return {
    controller: args.controller,
    keys: [{ keyType: "Ed25519", key: args.supplierPubKeyHex, purposes: SUPPLIER_KEY_PURPOSES, pop: null }],
    parties: [{
      role: "Accountable",
      signer: args.accountable,
      organisation: null,
      notBefore: args.window.lo,
      notAfter: null,
      rights: ROLE_MAX_RIGHTS.Accountable,
      removalAfter: null,
    }],
    profile,
  };
}

/** The identifier of the identity token in `assets` (policy + 32-byte name), or null. Ogmios units are "policy.name". */
function identityTokenName(assets: Record<string, bigint>, policy: string): string | null {
  for (const [unit, quantity] of Object.entries(assets)) {
    const flat = unit.toLowerCase().replace(".", "");
    if (quantity > 0n && flat.startsWith(policy) && flat.length === policy.length + 64) return flat.slice(policy.length);
  }
  return null;
}

/**
 * The agents whose live (not Revoked or Retired) record lists `keyHashHex`
 * with the transaction purpose, from a scan of the identity address. Each
 * supplier key gets one record (§9.2), so a second Register for the same key
 * is refused.
 */
export async function recordsListingKey(
  chain: ChainProvider,
  blueprint: IdentityBlueprint,
  networkId: 0 | 1,
  keyHashHex: string,
): Promise<string[]> {
  const agents: string[] = [];
  for (const utxo of await chain.queryUtxosByAddress(blueprint.identityScriptAddress(networkId))) {
    const agentId = identityTokenName(utxo.assets, blueprint.identityHash);
    if (agentId === null) continue;
    let record;
    try {
      record = readAgentRecord(utxo, blueprint.identityHash, agentId);
    } catch {
      continue; // not an authentic record output
    }
    if (record.status.type === "Revoked" || record.status.type === "Retired") continue;
    if (activeKey(record, keyHashHex, PURPOSE_TRANSACTION)) agents.push(agentId);
  }
  return agents;
}

/**
 * The capability_id values of the Active adverts of `supplierPkh` at the
 * given advert addresses (legacy and new), sorted and distinct.
 */
export async function advertCapabilities(
  chain: ChainProvider,
  advertAddresses: readonly string[],
  supplierPkh: string,
): Promise<string[]> {
  const capabilities = new Set<string>();
  for (const address of advertAddresses) {
    for (const utxo of await chain.queryUtxosByAddress(address)) {
      if (!utxo.datumHex) continue;
      try {
        const advert = decodeAdvert(utxo.datumHex).datum;
        if (advert.status === "Active" && advert.supplier_pkh === supplierPkh) capabilities.add(advert.capability_id);
      } catch {
        // Not an advert datum.
      }
    }
  }
  return [...capabilities].sort();
}

/**
 * Builds the Register transaction of the supplier key's record and signs it
 * with the supplier key (the listed key and the wallet). Returns the
 * registration file for the other signers.
 */
export async function buildRegistration(
  registrar: RecordRegistrar,
  args: RegisterRecordArgs & { networkId: 0 | 1 },
): Promise<RegistrationFile> {
  const built = await registrar.build(args);
  const supplierKeyHash = args.wallet.pubKeyHash;
  if (!built.requiredSigners.includes(supplierKeyHash) || !built.requiredSigners.includes(keyHash(args.controller))) {
    throw new Error("the Register transaction does not need the supplier key and the controller: refusing a wrong build");
  }
  const signed = await registrar.sign(built.txCborHex, args.wallet.privateKeyHex);
  if (registrar.txId(signed) !== built.txHash) throw new Error("signing changed the Register transaction body");
  const accountable = args.parties[0]?.signer ?? { type: "ControllerSet" as const };
  return {
    version: 1,
    network_id: args.networkId,
    agent_id: built.agentId,
    agent_did: vectorDid(built.agentId),
    tx_hash: built.txHash,
    tx_cbor: signed,
    required_signers: [...built.requiredSigners].sort(),
    signed_by: [supplierKeyHash],
    valid_until_ms: args.window.hi,
    record: {
      controller: args.controller,
      accountable,
      supplier_key: args.keys[0]!.key,
      name: args.profile.name,
      endpoint: args.profile.endpoint,
      capabilities: args.profile.capabilities,
    },
  };
}

/** Reads a registration file and checks its shape. */
export function parseRegistration(text: string): RegistrationFile {
  const value = JSON.parse(text) as RegistrationFile;
  const hex = (v: unknown, length: number): boolean => typeof v === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(v);
  if (value === null || typeof value !== "object" || value.version !== 1 || (value.network_id !== 0 && value.network_id !== 1) ||
      !hex(value.agent_id, 64) || value.agent_did !== vectorDid(value.agent_id) || !hex(value.tx_hash, 64) ||
      typeof value.tx_cbor !== "string" || !/^[0-9a-f]+$/.test(value.tx_cbor) ||
      !Array.isArray(value.required_signers) || !value.required_signers.every((s) => hex(s, 56)) ||
      !Array.isArray(value.signed_by) || !value.signed_by.every((s) => hex(s, 56)) ||
      !Number.isSafeInteger(value.valid_until_ms)) {
    throw new Error("not a registration file");
  }
  return value;
}

/**
 * Adds one signer's witness. The signer must be a required signer, and the
 * transaction body must stay the same.
 */
export async function signRegistration(
  witnesses: TransactionWitnesses,
  file: RegistrationFile,
  privateKeyHex: string,
  publicKeyHex: string,
): Promise<RegistrationFile> {
  const signer = keyHash(publicKeyHex);
  if (!file.required_signers.includes(signer)) throw new Error(`key ${signer} is not a required signer of this registration`);
  if (witnesses.txId(file.tx_cbor) !== file.tx_hash) throw new Error("the registration transaction does not match its tx_hash");
  const signed = await witnesses.sign(file.tx_cbor, privateKeyHex);
  if (witnesses.txId(signed) !== file.tx_hash) throw new Error("signing changed the Register transaction body");
  return { ...file, tx_cbor: signed, signed_by: [...new Set([...file.signed_by, signer])].sort() };
}

/** The required signers that have not signed yet. */
export function missingSigners(file: RegistrationFile): string[] {
  return file.required_signers.filter((signer) => !file.signed_by.includes(signer));
}

/**
 * Submits a fully signed registration and waits for it. Refuses a file with
 * a missing signer, a changed body, or a passed validity window.
 */
export async function submitRegistration(
  witnesses: TransactionWitnesses,
  chain: ChainProvider,
  file: RegistrationFile,
  options: { nowMs: number; awaitTimeoutMs: number },
): Promise<string> {
  const missing = missingSigners(file);
  if (missing.length > 0) throw new Error(`the registration still needs these signers: ${missing.join(", ")}`);
  if (witnesses.txId(file.tx_cbor) !== file.tx_hash) throw new Error("the registration transaction does not match its tx_hash");
  if (options.nowMs >= file.valid_until_ms) {
    throw new Error("the registration window has passed; build a new registration");
  }
  await chain.submitTx(file.tx_cbor);
  await chain.awaitTx(file.tx_hash, options.awaitTimeoutMs);
  return file.agent_id;
}
