/**
 * Transaction builders of the identity contract (Part 2 §3): Register (also
 * subagents), Adopt (§3.4, §9.1) and the twelve spends of §3.5–§3.7.
 *
 * Each builder checks the rules of its action before it builds, with the
 * same definitions as the contract (`records.ts`), and refuses inputs that
 * the contract would reject. It adds the reference inputs that the rules
 * read (the configuration record when a record output has a Module-1 party,
 * parents and ancestors, successors) and returns the key hashes that must
 * sign.
 */

import type { Utxo } from "../../chain/ChainProvider.js";
import {
  decodeLegacyDatum, identityDatumToData, type Hold, type IdentityDatum, type Key, type LegacyDatum, type Party,
  type Signer, type Status,
} from "../../cbor/IdentityDatum.js";
import { identityMintToData, identitySpendToData, type Actor, type IdentitySpend } from "../../cbor/IdentityRedeemer.js";
import type { PlutusData } from "../../cbor/plutus-data.js";
import { buildAllowlistTree, verifyAllowlistProof } from "../allowlist.js";
import {
  CAPABILITY_MAX_BYTES, DAYS_30_MS, DAYS_7_MS, DESCRIPTION_MAX_BYTES, ENDPOINT_MAX_BYTES, FRAMEWORK_MAX_BYTES,
  MAX_CAPABILITIES, MAX_DEPTH, MIN_RECORD_LOVELACE, NAME_MAX_BYTES, RIGHT_RECOVER, RIGHT_REVOKE, RIGHT_SUSPEND,
  ROLE_MAX_RIGHTS,
} from "../constants.js";
import { keyHash, utf8FromHex, utf8ToHex, vectorIdFromSeed } from "../id.js";
import { completeTx, type PlannedMint, type PlannedWithdrawal, type TxPlan } from "./complete.js";
import { coinForOutput, enterpriseAddress, isEnterpriseAddressOf, paymentCredential, utxoAssets, type TxOutput } from "./ledger.js";
import {
  accountable, ancestorChain, covers, datumMap, effectiveStatus, guardianBound, hasRight, hasScriptParty, partyEquals,
  readConfigRecord, readRecord, recordMap, requireValidDatum, sameParty, sameSigner, terminal, type RecordUtxo,
} from "./records.js";
import { refuse, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow } from "./types.js";

// ─── Deployment and shared arguments ─────────────────────────────────

/** The identity deployment that the builders need (Part 2 §2, §3.8). */
export interface IdentityScripts {
  /** The applied `identity` validator. Its hash is the policy ID; IA is its enterprise address. */
  identity: ScriptSource;
  /** Policy of the configuration token (`config_seal` hash), an identity parameter. */
  configPolicy: string;
  /** `config_holder` hash, an identity parameter. */
  configHolder: string;
  /** The configuration record: needed when a record output has a Module-1 party (M1 comes from it). */
  configRecord?: Utxo;
  /** Module-1 `identity_party` (hash M1): the withdrawal script of a Module-1 consent. */
  module1?: ScriptSource;
}

/** Adoption also needs the legacy registry (Part 2 §2: `legacy_hash`, `legacy_root`). */
export interface AdoptionScripts extends IdentityScripts {
  /** The deployed legacy registry script (`be1a0a29…` on mainnet). It runs the Deregister and the Burn. */
  legacy: ScriptSource;
  /** The allowlist root that the identity validator was built with. */
  legacyRoot: string;
}

/** Profile fields as text (Part 1 §5 limits: name 1–64 bytes, description and endpoint ≤ 256, framework ≤ 64, ≤ 16 capabilities of 1–64 bytes). */
export interface Profile {
  name: string;
  description?: string;
  framework?: string;
  endpoint?: string;
  capabilities?: string[];
}

/** The minimum AP3X of a live record output (10 AP3X). */
export const RECORD_DEPOSIT = MIN_RECORD_LOVELACE;

/** The legacy Deregister rule: one output of at least 10 AP3X to the owner's key hash (Part 2 §9.1). */
export const LEGACY_CHANGE_MIN = 10_000_000n;

/** Reason codes allowed in a new hold (Appendix A, "Allowed in" Suspend). */
export const SUSPEND_REASONS: readonly number[] = [0, 6, 9, 64, 65, 67, 68];
/** Reason codes allowed in a revocation (Appendix A, "Allowed in" Revoke). */
export const REVOKE_REASONS: readonly number[] = [0, 1, 3, 4, 5, 9, 64, 65];
const REASON_KEY_COMPROMISE = 1;
const REASON_DISPUTE_VERDICT = 64;

/** Legacy registry redeemers: `SpendAction.Deregister` and `MintAction.Burn` (both constructor 1). */
const LEGACY_DEREGISTER: PlutusData = { kind: "constr", index: 1n, fields: [] };
const LEGACY_BURN: PlutusData = { kind: "constr", index: 1n, fields: [] };
/** Module-1 `PartyApproval.Consent` (constructor 0). */
const MODULE1_CONSENT: PlutusData = { kind: "constr", index: 0n, fields: [] };

/** An Ed25519 listed key. Purposes: a sum of 1 (authentication), 2 (assertion), 8 (transaction), 16 (delegation). */
export const ed25519Key = (publicKey: string, purposes: number): Key => ({ keyType: "Ed25519", key: publicKey, purposes, pop: null });

/** A P-256 listed key (33-byte compressed point) with its pop (`createP256Pop`). Purposes: a sum of 1 and 2. */
export const p256Key = (publicKey: string, purposes: number, pop: string): Key => ({ keyType: "P256", key: publicKey, purposes, pop });

// ─── Shared helpers ──────────────────────────────────────────────────

/** The parts of a transaction that the rules of one action add. */
interface Needs {
  signers: Set<string>;
  references: Map<string, Utxo>;
  consent: boolean;
}

const newNeeds = (): Needs => ({ signers: new Set(), references: new Map(), consent: false });
const refKey = (utxo: Utxo): string => `${utxo.ref.txHash}#${utxo.ref.index}`;
const addReference = (needs: Needs, utxo: Utxo): void => void needs.references.set(refKey(utxo), utxo);

function profileHex(profile: Profile): Pick<IdentityDatum, "name" | "description" | "framework" | "endpoint" | "capabilities"> {
  return {
    name: utf8ToHex(profile.name),
    description: utf8ToHex(profile.description ?? ""),
    framework: utf8ToHex(profile.framework ?? ""),
    endpoint: utf8ToHex(profile.endpoint ?? ""),
    capabilities: (profile.capabilities ?? []).map(utf8ToHex),
  };
}

/** M1 from the configuration record, or null when the deployment gives none. */
function module1Of(scripts: IdentityScripts): string | null {
  return scripts.configRecord === undefined ? null : readConfigRecord(scripts.configRecord, scripts.configPolicy, scripts.configHolder);
}

/** `ok(signer)` of Part 2 §3.2 as transaction needs. `Script` needs the Module-1 consent (§3.8). */
function authorise(needs: Needs, signer: Signer, controller: string): void {
  if (signer.type === "KeyHash") needs.signers.add(signer.hash);
  else if (signer.type === "ControllerSet") needs.signers.add(keyHash(controller));
  else needs.consent = true;
}

/**
 * The rules that Module-1 checks before it consents (§3.8): each new
 * Module-1 party is Accountable or Responsible with the role's highest
 * rights, `not_before ≤ lo`, no `not_after` and no `removal_after`; every
 * Module-1 party of `D` stays unchanged.
 */
function checkConsent(before: readonly Party[], after: readonly Party[], lo: number): void {
  for (const party of after) {
    if (party.signer.type !== "Script") continue;
    const match = before.find((p) => sameParty(p, party));
    if (match !== undefined) {
      if (!partyEquals(match, party)) refuse("module1_party_changed", "Module-1 consents only while each of its parties stays unchanged");
      continue;
    }
    if (party.role !== "Accountable" && party.role !== "Responsible") {
      refuse("module1_role", "Module-1 can be only an Accountable or a Responsible party");
    }
    if (party.rights !== ROLE_MAX_RIGHTS[party.role]) {
      refuse("module1_rights", `a Module-1 ${party.role} party has rights ${ROLE_MAX_RIGHTS[party.role]}`);
    }
    if (party.notBefore > lo || party.notAfter !== null || party.removalAfter !== null) {
      refuse("module1_period", "a new Module-1 party needs not_before ≤ lo, no not_after and no removal_after");
    }
  }
  for (const party of before) {
    if (party.signer.type === "Script" && !after.some((p) => partyEquals(p, party))) {
      refuse("module1_party_changed", "Module-1 consents only while each of its parties stays unchanged");
    }
  }
}

/**
 * The Module-1 consent withdrawal from Script(M1) with the redeemer Consent.
 * The ledger accepts only a withdrawal of the whole reward balance, so the
 * amount is `ctx.rewardBalances[M1]`, which the caller reads from the chain.
 */
function consentWithdrawal(ctx: TxContext, scripts: IdentityScripts, m1: string): PlannedWithdrawal {
  if (scripts.module1 === undefined) refuse("module1_script_missing", "a Module-1 consent needs the Module-1 script (scripts.module1)");
  if (scripts.module1.hash !== m1) refuse("module1_script_mismatch", `the Module-1 script is ${scripts.module1.hash}, but the configuration record names ${m1}`);
  const amount = ctx.rewardBalances?.[m1];
  if (amount === undefined || amount < 0n) {
    refuse("reward_balance_missing", `a Module-1 consent withdraws the whole reward balance of ${m1}; read it from the chain and pass ctx.rewardBalances`);
  }
  return { credential: { type: "Script", hash: m1 }, amount, redeemer: { data: MODULE1_CONSENT, label: "Module-1 Consent" }, script: scripts.module1 };
}

/** Adds the configuration reference input when the datum has a Module-1 party; returns M1 or null. */
function configFor(needs: Needs, scripts: IdentityScripts, datum: IdentityDatum, label: string): string | null {
  const m1 = module1Of(scripts);
  if (hasScriptParty(datum) || needs.consent) {
    if (m1 === null || scripts.configRecord === undefined) {
      refuse("config_record_missing", `${label} has a Module-1 party: the configuration record must be a reference input (scripts.configRecord)`);
    }
    addReference(needs, scripts.configRecord);
  }
  return m1;
}

function recordOutput(ctx: TxContext, scripts: IdentityScripts, id: string, datum: IdentityDatum, floor: bigint): TxOutput {
  const shape = {
    address: enterpriseAddress({ type: "Script", hash: scripts.identity.hash }, ctx.networkId),
    assets: [{ policy: scripts.identity.hash, name: id, quantity: 1n }],
    datum: identityDatumToData(datum),
    scriptRef: null,
  };
  return { ...shape, coin: coinForOutput(shape, ctx.protocol.coinsPerUtxoByte, floor) };
}

/** Checks a record's ancestors and returns them as reference UTxOs (parent first). */
function ancestorsOf(scripts: IdentityScripts, record: IdentityDatum, ancestors: readonly Utxo[] | undefined, label: string): RecordUtxo[] {
  const read = (ancestors ?? []).map((u, i) => readRecord(u, scripts.identity.hash, `${label} ancestor ${i}`));
  return ancestorChain(record, recordMap(read));
}

// ─── Register and Adopt (§3.4) ───────────────────────────────────────

/** The fields of a new record that the caller chooses. */
export interface NewRecord {
  /** The controller's Ed25519 public key (32 bytes, hex). It signs. */
  controller: string;
  /** Listed keys. Each Ed25519 key signs. Each P-256 key carries its pop. */
  keys?: Key[];
  /** At least one Accountable party that covers the validity window. Each party signs (`ok`). */
  parties: Party[];
  guardianThreshold?: number;
  profile: Profile;
  /** The record output's AP3X (default and minimum 10 AP3X; raised to the min-UTxO). */
  deposit?: bigint;
}

export interface RegisterArgs extends NewRecord {
  /** The UTxO that the transaction spends; the identifier is `blake2b_256(serialise(seed))`. A key-locked UTxO. */
  seed: Utxo;
  window: ValidityWindow;
  /** For a subagent: the parent's record and every ancestor of the parent (reference inputs). */
  parent?: { record: Utxo; ancestors?: Utxo[] };
}

export interface CreatedRecordTx extends UnsignedTx {
  /** The new identifier (64 hex characters). */
  id: string;
  /** The index of the record output in `outputs`. */
  recordOutput: number;
}

/** Rules 4–8 of Register, which Adopt shares: the record D0, its checks and its signers. */
function createdRecord(
  ctx: TxContext,
  scripts: IdentityScripts,
  args: NewRecord & { window: ValidityWindow },
  id: string,
  lineage: IdentityDatum["lineage"],
  needs: Needs,
): { output: TxOutput; datum: IdentityDatum; m1: string | null } {
  const { lo, hi } = args.window;
  const profile = profileHex(args.profile);
  const datum: IdentityDatum = {
    controller: args.controller,
    keys: args.keys ?? [],
    parties: args.parties,
    guardianThreshold: args.guardianThreshold ?? 0,
    pendingRecovery: null,
    lineage,
    subagentEpoch: 0,
    ...profile,
    createdAt: hi,
    status: { type: "Active" },
  };
  for (const key of datum.keys) {
    if (key.keyType === "Ed25519") needs.signers.add(keyHash(key.key));
  }
  needs.signers.add(keyHash(datum.controller));
  for (const party of datum.parties) authorise(needs, party.signer, datum.controller);
  const m1 = configFor(needs, scripts, datum, "the new record");
  requireValidDatum(datum, m1, "the new record");
  if (!accountable(datum, lo, hi)) refuse("not_accountable", "the new record needs an Accountable party that covers the validity window");
  if (!guardianBound(datum, hi)) refuse("guardian_bound", "guardian_threshold exceeds the guardians with the recover right");
  if (needs.consent) checkConsent([], datum.parties, lo);
  const deposit = args.deposit ?? RECORD_DEPOSIT;
  if (deposit < RECORD_DEPOSIT) refuse("deposit_too_low", `a live record holds at least ${RECORD_DEPOSIT} base units`);
  return { output: recordOutput(ctx, scripts, id, datum, deposit), datum, m1 };
}

/** Register { seed } (§3.4), also for a subagent. */
export function buildRegister(ctx: TxContext, scripts: IdentityScripts, args: RegisterArgs): CreatedRecordTx {
  const id = vectorIdFromSeed(args.seed.ref.txHash, args.seed.ref.index);
  if (paymentCredential(args.seed.address)?.type !== "VerificationKey") {
    refuse("seed_not_key_locked", "the seed must be a key-locked UTxO");
  }
  const needs = newNeeds();
  let lineage: IdentityDatum["lineage"] = { type: "Root" };
  if (args.parent !== undefined) {
    const parent = readRecord(args.parent.record, scripts.identity.hash, "parent");
    const chain = ancestorsOf(scripts, parent.datum, args.parent.ancestors, "parent");
    const status = effectiveStatus(parent.datum, datumMap(chain), args.window.lo, args.window.hi);
    if (status !== "Active") refuse("parent_not_active", `the parent's effective status is ${status}; a subagent needs an Active parent`);
    const depth = (parent.datum.lineage.type === "Root" ? 0 : parent.datum.lineage.depth) + 1;
    if (depth > MAX_DEPTH) refuse("subagent_too_deep", `a subagent of depth ${depth} exceeds the limit of ${MAX_DEPTH}`);
    lineage = { type: "Subagent", parent: parent.id, parentEpoch: parent.datum.subagentEpoch, depth };
    needs.signers.add(keyHash(parent.datum.controller));
    addReference(needs, parent.utxo);
    for (const ancestor of chain) addReference(needs, ancestor.utxo);
  }
  const created = createdRecord(ctx, scripts, args, id, lineage, needs);
  const plan: TxPlan = {
    inputs: [{ utxo: args.seed }],
    referenceInputs: [...needs.references.values()],
    outputs: [created.output],
    mints: [{
      policy: scripts.identity.hash,
      assets: [{ name: id, quantity: 1n }],
      redeemer: { data: identityMintToData({ type: "Register", seed: args.seed.ref }), label: "identity Register" },
      script: scripts.identity,
    }],
    withdrawals: needs.consent ? [consentWithdrawal(ctx, scripts, created.m1!)] : [],
    extraSignatories: [...needs.signers],
    window: args.window,
  };
  return { ...completeTx(ctx, plan), id, recordOutput: 0 };
}

export interface AdoptArgs extends Omit<NewRecord, "profile"> {
  /** The legacy record: at the exact legacy address, one legacy token, an inline LegacyDatum with a key owner. */
  legacyRecord: Utxo;
  /** The published allowlist (every identifier); the builder makes the Merkle proof (§3.4). */
  allowlist: readonly string[];
  window: ValidityWindow;
  /**
   * New profile values. Each legacy field that obeys the limits is copied;
   * a field that breaks a limit needs a value here. A value here also
   * replaces a valid legacy field.
   */
  profile?: Partial<Profile>;
  /** Where the 10 AP3X of the legacy change rule go; default the owner's enterprise address. */
  ownerAddress?: string;
}

/** The legacy fields as text, with each limit that a field breaks. */
export function legacyProfile(legacy: LegacyDatum): { profile: Profile; broken: Array<keyof Profile> } {
  const broken: Array<keyof Profile> = [];
  const text = (hex: string, field: keyof Profile): string => {
    const value = utf8FromHex(hex);
    if (value === null) {
      broken.push(field);
      return "";
    }
    return value;
  };
  const name = text(legacy.name, "name");
  const description = text(legacy.description, "description");
  const framework = text(legacy.framework, "framework");
  const endpoint = text(legacy.endpoint, "endpoint");
  const capabilities = legacy.capabilities.map((c) => utf8FromHex(c));
  const bytes = (hex: string): number => hex.length / 2;
  if (!broken.includes("name") && (bytes(legacy.name) < 1 || bytes(legacy.name) > NAME_MAX_BYTES)) broken.push("name");
  if (!broken.includes("description") && bytes(legacy.description) > DESCRIPTION_MAX_BYTES) broken.push("description");
  if (!broken.includes("framework") && bytes(legacy.framework) > FRAMEWORK_MAX_BYTES) broken.push("framework");
  if (!broken.includes("endpoint") && bytes(legacy.endpoint) > ENDPOINT_MAX_BYTES) broken.push("endpoint");
  const capabilitiesBroken = legacy.capabilities.length > MAX_CAPABILITIES
    || capabilities.some((c) => c === null)
    || legacy.capabilities.some((c, i) => bytes(c) < 1 || bytes(c) > CAPABILITY_MAX_BYTES || legacy.capabilities.indexOf(c) !== i);
  if (capabilitiesBroken) broken.push("capabilities");
  return {
    profile: { name, description, framework, endpoint, capabilities: capabilitiesBroken ? [] : capabilities.map((c) => c!) },
    broken,
  };
}

/** Adopt { proof } (§3.4, §9.1): Deregister + Burn of the legacy record and the mint of the identity record, in one transaction. */
export function buildAdopt(ctx: TxContext, scripts: AdoptionScripts, args: AdoptArgs): CreatedRecordTx {
  const legacyAddress = enterpriseAddress({ type: "Script", hash: scripts.legacy.hash }, ctx.networkId);
  const where = `legacy record ${refKey(args.legacyRecord)}`;
  if (!isEnterpriseAddressOf(args.legacyRecord.address, { type: "Script", hash: scripts.legacy.hash })) {
    refuse("legacy_not_authentic", `${where} is not at the legacy address ${legacyAddress}`);
  }
  const tokens = utxoAssets(args.legacyRecord).filter((a) => a.policy === scripts.legacy.hash);
  if (tokens.length !== 1 || tokens[0]!.quantity !== 1n) refuse("legacy_not_authentic", `${where} does not hold exactly one legacy token`);
  const id = tokens[0]!.name;
  if (args.legacyRecord.datumHex === null) refuse("legacy_datum_missing", `${where} has no inline datum; it cannot adopt`);
  let legacy: LegacyDatum;
  try {
    legacy = decodeLegacyDatum(args.legacyRecord.datumHex);
  } catch (error) {
    return refuse("legacy_datum_invalid", `${where}: the datum does not decode, so the record cannot adopt (${error instanceof Error ? error.message : String(error)})`);
  }
  if (legacy.owner.type !== "VerificationKey") refuse("legacy_script_owner", `${where} has a script owner, so it cannot adopt`);
  const owner = legacy.owner.hash;

  let proof: string[];
  try {
    proof = buildAllowlistTree(args.allowlist).proof(id);
  } catch (error) {
    return refuse("not_allowlisted", `${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!verifyAllowlistProof(scripts.legacyRoot, id, proof)) {
    refuse("allowlist_root_mismatch", "the allowlist does not give the legacy_root of the identity deployment");
  }

  const copied = legacyProfile(legacy);
  const missing = copied.broken.filter((field) => args.profile?.[field] === undefined);
  if (missing.length > 0) {
    refuse("legacy_profile_over_limits", `${where}: the legacy ${missing.join(", ")} break the record limits; give new values in profile`);
  }
  const override = args.profile ?? {};
  const profile: Profile = {
    name: override.name ?? copied.profile.name,
    description: override.description ?? copied.profile.description,
    framework: override.framework ?? copied.profile.framework,
    endpoint: override.endpoint ?? copied.profile.endpoint,
    capabilities: override.capabilities ?? copied.profile.capabilities,
  };

  const needs = newNeeds();
  needs.signers.add(owner);
  const created = createdRecord(ctx, scripts, { ...args, profile }, id, { type: "Root" }, needs);
  const outputs: TxOutput[] = [created.output];
  let changeMin: bigint | undefined;
  const ownerAddress = args.ownerAddress ?? enterpriseAddress({ type: "VerificationKey", hash: owner }, ctx.networkId);
  if (paymentCredential(ownerAddress)?.hash !== owner) refuse("owner_address_invalid", "ownerAddress must pay to the legacy owner's key hash");
  if (args.ownerAddress === undefined && paymentCredential(ctx.changeAddress)?.hash === owner && paymentCredential(ctx.changeAddress)?.type === "VerificationKey") {
    // The change output is the owner's output: it must hold at least 10 AP3X.
    changeMin = LEGACY_CHANGE_MIN;
  } else {
    outputs.push({ address: ownerAddress, coin: LEGACY_CHANGE_MIN, assets: [], datum: null, scriptRef: null });
  }
  const mints: PlannedMint[] = [
    {
      policy: scripts.identity.hash,
      assets: [{ name: id, quantity: 1n }],
      redeemer: { data: identityMintToData({ type: "Adopt", proof }), label: "identity Adopt" },
      script: scripts.identity,
    },
    { policy: scripts.legacy.hash, assets: [{ name: id, quantity: -1n }], redeemer: { data: LEGACY_BURN, label: "legacy Burn" }, script: scripts.legacy },
  ];
  const plan: TxPlan = {
    inputs: [{ utxo: args.legacyRecord, redeemer: { data: LEGACY_DEREGISTER, label: "legacy Deregister" }, script: scripts.legacy }],
    referenceInputs: [...needs.references.values()],
    outputs,
    mints,
    withdrawals: needs.consent ? [consentWithdrawal(ctx, scripts, created.m1!)] : [],
    extraSignatories: [...needs.signers],
    window: args.window,
    ...(changeMin === undefined ? {} : { changeMin }),
  };
  return { ...completeTx(ctx, plan), id, recordOutput: 0 };
}

// ─── Spends (§3.5) ───────────────────────────────────────────────────

interface SpendArgsBase {
  /** The record to spend. */
  record: Utxo;
  window: ValidityWindow;
}

/** How the record output's AP3X may change (§3.5 "Value"). */
type ValueRule = { kind: "floor"; deposit?: bigint } | { kind: "kept" } | { kind: "minimum"; coin?: bigint };

function spendRecord(
  ctx: TxContext,
  scripts: IdentityScripts,
  spent: RecordUtxo,
  window: ValidityWindow,
  redeemer: IdentitySpend,
  next: IdentityDatum,
  value: ValueRule,
  needs: Needs,
): UnsignedTx {
  const m1 = configFor(needs, scripts, next, "the record output");
  requireValidDatum(next, m1, "the record output");
  if (needs.consent) {
    if (redeemer.type !== "Update") {
      refuse("module1_not_approving", "Module-1 approves only consents and verdict applications; build a verdict application with the Module-1 tools");
    }
    checkConsent(spent.datum.parties, next.parties, window.lo);
  }
  let floor: bigint;
  if (value.kind === "kept") floor = spent.utxo.lovelace;
  else if (value.kind === "floor") {
    floor = value.deposit ?? (spent.utxo.lovelace > RECORD_DEPOSIT ? spent.utxo.lovelace : RECORD_DEPOSIT);
    if (floor < RECORD_DEPOSIT) refuse("deposit_too_low", `a live record holds at least ${RECORD_DEPOSIT} base units`);
  } else floor = value.coin ?? 0n;
  const plan: TxPlan = {
    inputs: [{ utxo: spent.utxo, redeemer: { data: identitySpendToData(redeemer), label: `identity ${redeemer.type}` }, script: scripts.identity }],
    referenceInputs: [...needs.references.values()],
    outputs: [recordOutput(ctx, scripts, spent.id, next, floor)],
    mints: [],
    withdrawals: needs.consent ? [consentWithdrawal(ctx, scripts, m1!)] : [],
    extraSignatories: [...needs.signers],
    window,
  };
  return completeTx(ctx, plan);
}

/** Reads the spent record and refuses a terminal record for an action that needs a live one. */
function liveRecord(scripts: IdentityScripts, utxo: Utxo, action: string): RecordUtxo {
  const spent = readRecord(utxo, scripts.identity.hash);
  if (terminal(spent.datum)) refuse("record_terminal", `${action} needs a live record; this record is ${spent.datum.status.type}`);
  return spent;
}

/** The tombstone of a record with `status` (§3.7). */
function tombstone(record: IdentityDatum, status: Status): IdentityDatum {
  return {
    ...record,
    keys: [],
    parties: [],
    guardianThreshold: 0,
    pendingRecovery: null,
    description: "",
    framework: "",
    endpoint: "",
    capabilities: [],
    status,
  };
}

/** The successor rules (§3.7): `s ≠ id`, a live Root record of `s` as a reference input, its controller signs. */
function successorOf(scripts: IdentityScripts, needs: Needs, id: string, utxo: Utxo): string {
  const successor = readRecord(utxo, scripts.identity.hash, "successor");
  if (successor.id === id) refuse("successor_self", "a record cannot be its own successor");
  if (terminal(successor.datum)) refuse("successor_not_live", "the successor record must be live");
  if (successor.datum.lineage.type !== "Root") refuse("successor_not_root", "the successor must be a record without a parent");
  addReference(needs, successor.utxo);
  needs.signers.add(keyHash(successor.datum.controller));
  return successor.id;
}

/** The author of a Suspend or Revoke and the transaction needs of its authority (`acting` of the contract). */
function actingAuthor(spent: RecordUtxo, actor: Actor, right: number, window: ValidityWindow, needs: Needs): Signer {
  if (actor.type === "ByController") {
    needs.signers.add(keyHash(spent.datum.controller));
    return { type: "ControllerSet" };
  }
  const party = spent.datum.parties[actor.index];
  if (party === undefined) refuse("party_missing", `the record has no party ${actor.index}`);
  if (!hasRight(party.rights, right)) {
    refuse("party_without_right", `party ${actor.index} has no ${right === RIGHT_SUSPEND ? "suspend" : "revoke"} right`);
  }
  if (!covers(party, window.lo, window.hi)) refuse("party_not_covering", `party ${actor.index} does not cover the validity window`);
  if (party.signer.type === "Script") {
    refuse("module1_not_approving", "Module-1 acts only through a verdict application; build it with the Module-1 tools");
  }
  authorise(needs, party.signer, spent.datum.controller);
  return party.signer;
}

/** A current author (§3.2): ControllerSet, the signer of a party, or any Script signer. */
function currentAuthor(signer: Signer, parties: readonly Party[]): boolean {
  return signer.type !== "KeyHash" || parties.some((p) => sameSigner(p.signer, signer));
}

/** The holds that a Suspend or an Unsuspend by `author` keeps: in force, another current author, in their order. */
function keptHolds(record: IdentityDatum, author: Signer, lo: number): Hold[] {
  const holds = record.status.type === "Suspended" ? record.status.holds : [];
  return holds.filter((h) => h.until > lo && !sameSigner(h.by, author) && currentAuthor(h.by, record.parties));
}

function checkReason(reason: number, allowed: readonly number[], action: string): void {
  if (!allowed.includes(reason)) refuse("reason_not_allowed", `reason ${reason} is not allowed in ${action} (Appendix A: ${allowed.join(", ")})`);
  if (reason === REASON_DISPUTE_VERDICT) refuse("reason_module1_only", "reason 64 (disputeVerdict) is only for Module-1");
}

export interface UpdateArgs extends SpendArgsBase {
  /** The complete new key list (default: unchanged). A kept key keeps its type, purposes and pop. */
  keys?: Key[];
  /**
   * The complete new party list (default: unchanged). Matched parties keep
   * their order and new parties come last. A changed or new party signs,
   * except a removal notice of at least 7 days. A removed party signs, or
   * its notice has passed.
   */
  parties?: Party[];
  guardianThreshold?: number;
  /** Profile fields to change. */
  profile?: Partial<Profile>;
  /** The record output's AP3X (default: as spent; at least 10 AP3X). */
  deposit?: bigint;
}

/** `party` equals `match` except that `removal_after` goes from empty to `t ≥ hi + 7 days`. */
function noticeGiven(match: Party, party: Party, hi: number): boolean {
  return match.removalAfter === null && party.removalAfter !== null && party.removalAfter >= hi + DAYS_7_MS
    && partyEquals({ ...match, removalAfter: party.removalAfter }, party);
}

/** Update (§3.6): keys, parties (consent or notice), guardian threshold and profile. */
export function buildUpdate(ctx: TxContext, scripts: IdentityScripts, args: UpdateArgs): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "Update");
  const d = spent.datum;
  const { lo, hi } = args.window;
  const needs = newNeeds();
  needs.signers.add(keyHash(d.controller));

  const keys = args.keys ?? d.keys;
  for (const key of keys) {
    const kept = d.keys.find((k) => k.key === key.key);
    if (kept !== undefined) {
      if (kept.keyType !== key.keyType || kept.purposes !== key.purposes || kept.pop !== key.pop) {
        refuse("kept_key_changed", `key ${keyHash(key.key)} keeps its type, purposes and pop; remove it in one Update and add it again in another`);
      }
    } else if (key.keyType === "Ed25519") {
      needs.signers.add(keyHash(key.key));
    } else if (key.pop === null) {
      refuse("p256_pop_missing", `the new P-256 key ${keyHash(key.key)} needs its pop (createP256Pop)`);
    }
  }

  const parties = args.parties ?? d.parties;
  let last = -1;
  let appointed = false;
  for (const party of parties) {
    const index = d.parties.findIndex((p) => sameParty(p, party));
    if (index < 0) {
      appointed = true;
      authorise(needs, party.signer, d.controller);
      continue;
    }
    if (appointed) refuse("party_order", "new parties come after the kept parties");
    if (index <= last) refuse("party_order", "kept parties keep their order");
    last = index;
    const match = d.parties[index]!;
    if (!partyEquals(match, party) && !noticeGiven(match, party, hi)) authorise(needs, party.signer, d.controller);
  }
  for (const old of d.parties) {
    if (parties.some((p) => sameParty(p, old))) continue;
    if (old.removalAfter !== null && old.removalAfter <= lo) continue;
    if (old.signer.type === "Script") {
      refuse("module1_early_removal", "Module-1 never consents to its own early removal; set removal_after at least 7 days ahead first");
    }
    authorise(needs, old.signer, d.controller);
  }

  const guardianThreshold = args.guardianThreshold ?? d.guardianThreshold;
  const p = args.profile ?? {};
  const next: IdentityDatum = {
    ...d,
    keys,
    parties,
    guardianThreshold,
    pendingRecovery: guardianThreshold === 0 ? null : d.pendingRecovery,
    name: p.name === undefined ? d.name : utf8ToHex(p.name),
    description: p.description === undefined ? d.description : utf8ToHex(p.description),
    framework: p.framework === undefined ? d.framework : utf8ToHex(p.framework),
    endpoint: p.endpoint === undefined ? d.endpoint : utf8ToHex(p.endpoint),
    capabilities: p.capabilities === undefined ? d.capabilities : p.capabilities.map(utf8ToHex),
  };
  const partiesChanged = parties.length !== d.parties.length || parties.some((party, i) => !partyEquals(party, d.parties[i]!));
  if ((partiesChanged || guardianThreshold !== d.guardianThreshold) && !guardianBound(next, hi)) {
    refuse("guardian_bound", "guardian_threshold exceeds the guardians with the recover right; lower it in the same Update");
  }
  return spendRecord(ctx, scripts, spent, args.window, { type: "Update" }, next, { kind: "floor", deposit: args.deposit }, needs);
}

/** ChangeController: old and new controller sign; the epoch grows; a pending recovery ends. */
export function buildChangeController(
  ctx: TxContext,
  scripts: IdentityScripts,
  args: SpendArgsBase & { newController: string; deposit?: bigint },
): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "ChangeController");
  const needs = newNeeds();
  needs.signers.add(keyHash(spent.datum.controller));
  needs.signers.add(keyHash(args.newController));
  const next: IdentityDatum = {
    ...spent.datum,
    controller: args.newController,
    subagentEpoch: spent.datum.subagentEpoch + 1,
    pendingRecovery: null,
  };
  return spendRecord(ctx, scripts, spent, args.window, { type: "ChangeController" }, next, { kind: "floor", deposit: args.deposit }, needs);
}

export interface SuspendArgs extends SpendArgsBase {
  actor: Actor;
  /** Appendix A "Allowed in" Suspend: 0, 6, 9, 65, 67, 68 (64 is Module-1 only). */
  reason: number;
  /** The end of the hold: `hi < until ≤ lo + 30 days`. */
  until: number;
}

/** Suspend { actor }: adds or renews the author's own hold. */
export function buildSuspend(ctx: TxContext, scripts: IdentityScripts, args: SuspendArgs): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "Suspend");
  const { lo, hi } = args.window;
  const needs = newNeeds();
  const author = actingAuthor(spent, args.actor, RIGHT_SUSPEND, args.window, needs);
  checkReason(args.reason, SUSPEND_REASONS, "Suspend");
  if (!(args.until > hi && args.until <= lo + DAYS_30_MS)) {
    refuse("hold_until", `until must be after hi (${hi}) and at most 30 days after lo (${lo + DAYS_30_MS})`);
  }
  const holds = [...keptHolds(spent.datum, author, lo), { by: author, reason: args.reason, since: lo, until: args.until }];
  const next: IdentityDatum = { ...spent.datum, status: { type: "Suspended", holds } };
  return spendRecord(ctx, scripts, spent, args.window, { type: "Suspend", actor: args.actor }, next, { kind: "kept" }, needs);
}

/** Unsuspend { author }: removes the author's hold; Active when no hold remains. */
export function buildUnsuspend(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { author: Signer }): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "Unsuspend");
  const holds = spent.datum.status.type === "Suspended" ? spent.datum.status.holds : [];
  if (!holds.some((h) => sameSigner(h.by, args.author))) refuse("hold_missing", "the record has no hold by this author");
  if (args.author.type === "Script") refuse("module1_not_approving", "Module-1 never approves Unsuspend; its hold ends at its until");
  const needs = newNeeds();
  authorise(needs, args.author, spent.datum.controller);
  const remaining = keptHolds(spent.datum, args.author, args.window.lo);
  const status: Status = remaining.length === 0 ? { type: "Active" } : { type: "Suspended", holds: remaining };
  return spendRecord(ctx, scripts, spent, args.window, { type: "Unsuspend", author: args.author }, { ...spent.datum, status }, { kind: "kept" }, needs);
}

export interface RevokeArgs extends SpendArgsBase {
  actor: Actor;
  /** Appendix A "Allowed in" Revoke: 0, 1, 3, 4, 5, 9, 65 (64 is Module-1 only). */
  reason: number;
  /** Empty or in [created_at, lo]; reason 1 (keyCompromise) requires it. */
  invalidFrom?: number | null;
  /** Only the controller names a successor: its live Root record (reference input); its controller signs. */
  successor?: Utxo;
}

/** Revoke { actor }: the tombstone with Revoked { by, reason, at: lo, invalid_from, successor }. */
export function buildRevoke(ctx: TxContext, scripts: IdentityScripts, args: RevokeArgs): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "Revoke");
  const { lo } = args.window;
  const needs = newNeeds();
  const by = actingAuthor(spent, args.actor, RIGHT_REVOKE, args.window, needs);
  checkReason(args.reason, REVOKE_REASONS, "Revoke");
  const invalidFrom = args.invalidFrom ?? null;
  if (invalidFrom === null && args.reason === REASON_KEY_COMPROMISE) refuse("invalid_from_missing", "reason 1 (keyCompromise) requires invalid_from");
  // The pinned blueprint (b5d66a6) checks [created_at, lo]. A pending contract fix widens it to
  // [created_at − 3,600,000, lo]; the narrower range passes both, so the builder keeps it.
  if (invalidFrom !== null && (invalidFrom < spent.datum.createdAt || invalidFrom > lo)) {
    refuse("invalid_from_range", `invalid_from must be in [created_at ${spent.datum.createdAt}, lo ${lo}]`);
  }
  let successor: string | null = null;
  if (args.successor !== undefined) {
    if (args.actor.type !== "ByController") refuse("successor_by_party", "only the controller names a successor");
    successor = successorOf(scripts, needs, spent.id, args.successor);
  }
  const next = tombstone(spent.datum, { type: "Revoked", by, reason: args.reason, at: lo, invalidFrom, successor });
  return spendRecord(ctx, scripts, spent, args.window, { type: "Revoke", actor: args.actor }, next, { kind: "kept" }, needs);
}

/** Retire: the controller's tombstone with Retired { at: lo, successor }. The deposit above `recordCoin` (default the ledger minimum) is released. */
export function buildRetire(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { successor?: Utxo; recordCoin?: bigint }): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "Retire");
  const needs = newNeeds();
  needs.signers.add(keyHash(spent.datum.controller));
  const successor = args.successor === undefined ? null : successorOf(scripts, needs, spent.id, args.successor);
  const next = tombstone(spent.datum, { type: "Retired", at: args.window.lo, successor });
  return spendRecord(ctx, scripts, spent, args.window, { type: "Retire" }, next, { kind: "minimum", coin: args.recordCoin }, needs);
}

/** Reclaim: the controller of a tombstone takes the deposit above `recordCoin` (default the ledger minimum). */
export function buildReclaim(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { recordCoin?: bigint }): UnsignedTx {
  const spent = readRecord(args.record, scripts.identity.hash);
  if (!terminal(spent.datum)) refuse("record_live", "Reclaim needs a tombstone (Revoked or Retired)");
  const needs = newNeeds();
  needs.signers.add(keyHash(spent.datum.controller));
  return spendRecord(ctx, scripts, spent, args.window, { type: "Reclaim" }, spent.datum, { kind: "minimum", coin: args.recordCoin }, needs);
}

/** SetSuccessor: the controller of a tombstone without a successor names one. */
export function buildSetSuccessor(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { successor: Utxo }): UnsignedTx {
  const spent = readRecord(args.record, scripts.identity.hash);
  const status = spent.datum.status;
  if (status.type !== "Revoked" && status.type !== "Retired") refuse("record_live", "SetSuccessor needs a tombstone (Revoked or Retired)");
  if (status.successor !== null) refuse("successor_set", "the tombstone already names a successor");
  const needs = newNeeds();
  needs.signers.add(keyHash(spent.datum.controller));
  const successor = successorOf(scripts, needs, spent.id, args.successor);
  const next: IdentityDatum = { ...spent.datum, status: { ...status, successor } };
  return spendRecord(ctx, scripts, spent, args.window, { type: "SetSuccessor" }, next, { kind: "kept" }, needs);
}

/** BumpEpoch: ends every subagent created under the current epoch. */
export function buildBumpEpoch(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { deposit?: bigint }): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "BumpEpoch");
  const needs = newNeeds();
  needs.signers.add(keyHash(spent.datum.controller));
  const next: IdentityDatum = { ...spent.datum, subagentEpoch: spent.datum.subagentEpoch + 1 };
  return spendRecord(ctx, scripts, spent, args.window, { type: "BumpEpoch" }, next, { kind: "floor", deposit: args.deposit }, needs);
}

/** The guardians of a recovery: eligible (Guardian, recover right, covers), distinct signers, enough, each signs. */
function guardianNeeds(spent: RecordUtxo, guardians: readonly number[], window: ValidityWindow, needs: Needs): void {
  const chosen = guardians.map((index) => {
    const party = spent.datum.parties[index];
    if (party === undefined) refuse("party_missing", `the record has no party ${index}`);
    if (party.role !== "Guardian" || !hasRight(party.rights, RIGHT_RECOVER) || !covers(party, window.lo, window.hi)) {
      refuse("guardian_not_eligible", `party ${index} is not an eligible guardian (role Guardian, recover right, covers the window)`);
    }
    return party;
  });
  if (chosen.some((p, i) => chosen.slice(i + 1).some((q) => sameSigner(p.signer, q.signer)))) {
    refuse("guardians_not_distinct", "the guardians must have distinct signers");
  }
  if (chosen.length < spent.datum.guardianThreshold) {
    refuse("guardians_too_few", `${chosen.length} guardians; the threshold is ${spent.datum.guardianThreshold}`);
  }
  for (const party of chosen) authorise(needs, party.signer, spent.datum.controller);
}

/** RecoverInit { guardians }: starts a recovery to `newController`, effective 7 days after hi. */
export function buildRecoverInit(
  ctx: TxContext,
  scripts: IdentityScripts,
  args: SpendArgsBase & { guardians: number[]; newController: string },
): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "RecoverInit");
  if (spent.datum.pendingRecovery !== null) refuse("recovery_pending", "a recovery is already pending");
  if (spent.datum.guardianThreshold < 1) refuse("recovery_disabled", "the record has guardian_threshold 0");
  const needs = newNeeds();
  guardianNeeds(spent, args.guardians, args.window, needs);
  needs.signers.add(keyHash(args.newController));
  const next: IdentityDatum = {
    ...spent.datum,
    pendingRecovery: { newController: args.newController, effectiveAfter: args.window.hi + DAYS_7_MS },
  };
  return spendRecord(ctx, scripts, spent, args.window, { type: "RecoverInit", guardians: args.guardians }, next, { kind: "kept" }, needs);
}

/** RecoverCancel { guardians }: ends a pending recovery. */
export function buildRecoverCancel(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase & { guardians: number[] }): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "RecoverCancel");
  if (spent.datum.pendingRecovery === null) refuse("recovery_not_pending", "no recovery is pending");
  const needs = newNeeds();
  guardianNeeds(spent, args.guardians, args.window, needs);
  const next: IdentityDatum = { ...spent.datum, pendingRecovery: null };
  return spendRecord(ctx, scripts, spent, args.window, { type: "RecoverCancel", guardians: args.guardians }, next, { kind: "kept" }, needs);
}

/** RecoverFinalize: anybody, after effective_after ≤ lo; installs the new controller and ends the subagents. */
export function buildRecoverFinalize(ctx: TxContext, scripts: IdentityScripts, args: SpendArgsBase): UnsignedTx {
  const spent = liveRecord(scripts, args.record, "RecoverFinalize");
  const pending = spent.datum.pendingRecovery;
  if (pending === null) refuse("recovery_not_pending", "no recovery is pending");
  if (pending.effectiveAfter > args.window.lo) {
    refuse("recovery_too_early", `the recovery completes at ${pending.effectiveAfter}; lo is ${args.window.lo}`);
  }
  const next: IdentityDatum = {
    ...spent.datum,
    controller: pending.newController,
    pendingRecovery: null,
    subagentEpoch: spent.datum.subagentEpoch + 1,
  };
  return spendRecord(ctx, scripts, spent, args.window, { type: "RecoverFinalize" }, next, { kind: "kept" }, newNeeds());
}
