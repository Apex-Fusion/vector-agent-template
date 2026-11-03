/**
 * Transaction builders of the delegation contract (Part 2 §5.1–§5.2):
 * Delegate and Undelegate, and the off-chain copy of the pattern grammar and
 * of the use checks that a dependent contract (the vault) runs. The rules
 * follow `contracts/identity-marketplace/lib/identity_marketplace/delegation/`.
 */

import type { Utxo } from "../../chain/ChainProvider.js";
import {
  decodeDelegationDatum, delegationDatumToData, delegationMintToData, type DelegationDatum, type Delegator,
  type ValueLimit,
} from "../../cbor/Delegation.js";
import { MAX_ACTIONS, MAX_DEPTH, MAX_ESCROW_LOVELACE, MAX_RECORD_INT, MAX_RESOURCES, MAX_TIME_MS, PURPOSE_DELEGATION } from "../constants.js";
import { keyHash, utf8FromHex, utf8ToHex, vectorIdFromSeed } from "../id.js";
import { completeTx } from "./complete.js";
import { coinForOutput, enterpriseAddress, isEnterpriseAddressOf, paymentCredential, utxoAssets } from "./ledger.js";
import { activeKey, ancestorChain, datumMap, effectiveStatus, readRecord, recordMap, type RecordUtxo } from "./records.js";
import { refuse, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow } from "./types.js";

export interface DelegationScripts {
  /** The applied delegation validator: its hash is the policy ID; DA is its enterprise address. */
  delegation: ScriptSource;
  /** The identity policy (the `identity_hash` parameter). */
  identityHash: string;
}

// ─── Patterns (§5.1) ─────────────────────────────────────────────────

const INTERNAL = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const VISIBLE = /^[\x21-\x7e]+$/;

function schemeLength(pattern: string): number {
  if (pattern.startsWith("mcp:")) return 4;
  if (pattern.startsWith("oauth:")) return 6;
  if (pattern.startsWith("https://")) return 8;
  return 0;
}

const endsWithDotStar = (pattern: string): boolean => pattern.length >= 3 && pattern.endsWith(".*");

/** `action-pattern = "*" / internal / prefix / external`. */
export function validActionPattern(pattern: string): boolean {
  if (pattern === "*") return true;
  const scheme = schemeLength(pattern);
  if (scheme > 0) return VISIBLE.test(pattern.slice(scheme));
  return INTERNAL.test(endsWithDotStar(pattern) ? pattern.slice(0, -2) : pattern);
}

/** `resource-pattern = "*" / script / external`; script = "script:" and 56 lowercase hex digits. */
export function validResourcePattern(pattern: string): boolean {
  if (pattern === "*") return true;
  const scheme = schemeLength(pattern);
  if (scheme > 0) return VISIBLE.test(pattern.slice(scheme));
  return /^script:[0-9a-f]{56}$/.test(pattern);
}

/** `p` covers `a`: `p = "*"`, `p = a`, or `p = x ".*"` and `a` starts with `x "."`. External and script patterns match only exactly. */
export function patternCovers(pattern: string, value: string): boolean {
  if (pattern === "*" || pattern === value) return true;
  return endsWithDotStar(pattern) && value.startsWith(pattern.slice(0, -1)) && schemeLength(pattern) === 0 && !pattern.startsWith("script:");
}

export const patternsCover = (patterns: readonly string[], value: string): boolean => patterns.some((p) => patternCovers(p, value));

/** A child list is narrower than a parent list when a parent pattern covers each child pattern. */
export const narrower = (child: readonly string[], parent: readonly string[]): boolean => child.every((c) => patternsCover(parent, c));

/** The action of vault payments (§5.1). */
export const HIRE_ACTION = "marketplace.hire.v1";
/** The resource of vault payments: `script:<escrow_hash>` in lowercase hex. */
export const escrowResource = (escrowHash: string): string => `script:${escrowHash}`;

const text = (hex: string): string => utf8FromHex(hex) ?? "\u0000";

// ─── Reading delegations ─────────────────────────────────────────────

export interface DelegationUtxo {
  utxo: Utxo;
  id: string;
  datum: DelegationDatum;
  actions: string[];
  resources: string[];
}

/** An authentic delegation: exactly at DA, exactly one token of the policy, an inline DelegationDatum. */
export function readDelegation(delegationHash: string, utxo: Utxo, label = "delegation"): DelegationUtxo {
  const where = `${label} ${utxo.ref.txHash}#${utxo.ref.index}`;
  if (!isEnterpriseAddressOf(utxo.address, { type: "Script", hash: delegationHash })) refuse("delegation_not_authentic", `${where} is not at the delegation address`);
  const tokens = utxoAssets(utxo).filter((a) => a.policy === delegationHash);
  if (tokens.length !== 1 || tokens[0]!.quantity !== 1n) refuse("delegation_not_authentic", `${where} does not hold exactly one delegation token`);
  if (utxo.datumHex === null) refuse("delegation_not_authentic", `${where} has no inline datum`);
  const datum = decodeDelegationDatum(utxo.datumHex);
  return { utxo, id: tokens[0]!.name, datum, actions: datum.actions.map(text), resources: datum.resources.map(text) };
}

/** The reasons why a delegation datum is not valid (`valid_delegation`); empty when valid. */
export function delegationProblems(d: DelegationDatum): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  const bytes = (hex: string): number => hex.length / 2;
  const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME_MS;
  if (d.delegator.type === "PrincipalKey") {
    check(bytes(d.delegator.hash) === 28, "delegator: a key hash has 28 bytes");
    check(d.delegator.organisation === null || (bytes(d.delegator.organisation) >= 1 && bytes(d.delegator.organisation) <= 64), "delegator: organisation has 1..64 bytes");
  } else {
    check(bytes(d.delegator.id) === 32, "delegator: an agent identifier has 32 bytes");
  }
  check(d.parent === null || bytes(d.parent) === 32, "parent has 32 bytes");
  check(bytes(d.delegate) === 32, "delegate has 32 bytes");
  check(bytes(d.delegateKey) === 28, "delegate_key is a 28-byte key hash");
  check(d.actions.length >= 1 && d.actions.length <= MAX_ACTIONS, `1..${MAX_ACTIONS} actions`);
  d.actions.forEach((a, i) => check(validActionPattern(text(a)), `actions[${i}] is not an action pattern (§5.1)`));
  check(d.resources.length <= MAX_RESOURCES, `0..${MAX_RESOURCES} resources`);
  d.resources.forEach((r, i) => check(validResourcePattern(text(r)), `resources[${i}] is not a resource pattern (§5.1)`));
  check(validTime(d.notBefore) && validTime(d.notAfter) && d.notBefore < d.notAfter, "not_before < not_after, both valid times");
  check(d.depth >= 1 && d.remaining >= 0 && d.depth + d.remaining <= MAX_DEPTH, "depth ≥ 1, remaining ≥ 0, depth + remaining ≤ 4");
  check(d.purpose === null || bytes(d.purpose) === 32, "purpose has 32 bytes");
  if (d.value !== null) {
    check(d.value.perTx >= 0n && d.value.perTx <= d.value.total && d.value.total <= MAX_ESCROW_LOVELACE, "0 ≤ per_tx ≤ total ≤ 10,000 AP3X");
    check(Number.isSafeInteger(d.value.periodMs) && d.value.periodMs >= 1 && BigInt(d.value.periodMs) <= MAX_RECORD_INT, "period_ms ≥ 1");
  }
  return problems;
}

/** Reads identity records by identifier. */
function recordsById(identityHash: string, records: readonly Utxo[] | undefined): Map<string, RecordUtxo> {
  return recordMap((records ?? []).map((u, i) => readRecord(u, identityHash, `record ${i}`)));
}

/** A record and its ancestors: refuses when the record or an ancestor is missing. */
function recordWithAncestors(available: ReadonlyMap<string, RecordUtxo>, id: string, label: string): { record: RecordUtxo; chain: RecordUtxo[] } {
  const record = available.get(id);
  if (record === undefined) refuse("record_missing", `the record of ${label} ${id} must be a reference input`);
  return { record, chain: ancestorChain(record.datum, available) };
}

/** The effective status of an agent must be Active over the window; returns the UTxOs that the check reads. */
function requireActive(available: ReadonlyMap<string, RecordUtxo>, id: string, label: string, window: ValidityWindow): { record: RecordUtxo; refs: Utxo[] } {
  const { record, chain } = recordWithAncestors(available, id, label);
  const status = effectiveStatus(record.datum, datumMap(chain), window.lo, window.hi);
  if (status !== "Active") refuse("agent_not_active", `the effective status of ${label} ${id} is ${status}`);
  return { record, refs: [record.utxo, ...chain.map((r) => r.utxo)] };
}

/**
 * The use checks of a delegation by a dependent contract (§5.2), off-chain:
 * the delegation and its ancestors are authentic, each delegate and the root
 * agent delegator are Active, each delegate key is still listed with the
 * delegation purpose, the action and resource are covered, and the window is
 * inside the period. Returns the reference inputs that the checks read.
 */
export function delegationUse(args: {
  identityHash: string;
  delegationHash: string;
  leaf: Utxo;
  ancestors?: readonly Utxo[];
  records: readonly Utxo[];
  action: string;
  resource: string;
  window: ValidityWindow;
}): { leaf: DelegationUtxo; references: Utxo[] } {
  const leaf = readDelegation(args.delegationHash, args.leaf);
  const delegations = new Map((args.ancestors ?? []).map((u, i) => {
    const d = readDelegation(args.delegationHash, u, `ancestor delegation ${i}`);
    return [d.id, d] as const;
  }));
  const available = recordsById(args.identityHash, args.records);
  if (!patternsCover(leaf.actions, args.action)) refuse("action_not_covered", `the delegation does not cover the action ${args.action}`);
  if (!patternsCover(leaf.resources, args.resource)) refuse("resource_not_covered", `the delegation does not cover the resource ${args.resource}`);
  if (!(leaf.datum.notBefore <= args.window.lo && args.window.hi <= leaf.datum.notAfter)) {
    refuse("delegation_period", `the validity window is not inside the delegation period [${leaf.datum.notBefore}, ${leaf.datum.notAfter}]`);
  }
  const references = new Map<string, Utxo>();
  const add = (u: Utxo): void => void references.set(`${u.ref.txHash}#${u.ref.index}`, u);
  let link = leaf;
  for (let left = MAX_DEPTH; ; left -= 1) {
    if (left <= 0) refuse("delegation_too_deep", "the delegation chain has more than 4 links");
    add(link.utxo);
    const delegate = requireActive(available, link.datum.delegate, "delegate", args.window);
    delegate.refs.forEach(add);
    if (!activeKey(delegate.record.datum, link.datum.delegateKey, PURPOSE_DELEGATION)) {
      refuse("delegate_key_not_listed", `the delegate ${link.datum.delegate} no longer lists the key ${link.datum.delegateKey} with the delegation purpose`);
    }
    if (link.datum.parent === null) {
      if (link.datum.delegator.type === "Agent") requireActive(available, link.datum.delegator.id, "delegator", args.window).refs.forEach(add);
      break;
    }
    const parent = delegations.get(link.datum.parent);
    if (parent === undefined) refuse("delegation_ancestor_missing", `the parent delegation ${link.datum.parent} must be a reference input`);
    link = parent;
  }
  return { leaf, references: [...references.values()] };
}

// ─── Delegate ────────────────────────────────────────────────────────

export interface DelegateArgs {
  /** The UTxO that the transaction spends (key-locked); the token name is `blake2b_256(serialise(seed))`. */
  seed: Utxo;
  window: ValidityWindow;
  /**
   * Without `parent`: the delegator. A `PrincipalKey` signs; an `Agent` is
   * Active and its controller (default) or a listed delegation key
   * (`agentSigner`, a key hash) signs. With `parent`: leave it out; the
   * delegator is the parent's delegate, and the parent's delegate key signs.
   */
  delegator?: Delegator;
  agentSigner?: string;
  /** The parent delegation (a reference input) for a sub-delegation. */
  parent?: Utxo;
  /** The delegate agent's identifier. */
  delegate: string;
  /** Key hash of the delegate's Ed25519 key with the delegation purpose. It signs. */
  delegateKey: string;
  /** Action patterns (§5.1), 1..16. */
  actions: string[];
  /** Resource patterns (§5.1), 0..8. An empty list covers nothing. */
  resources: string[];
  notBefore: number;
  notAfter: number;
  /** Further hops below this one; depth + remaining ≤ 4. */
  remaining: number;
  purpose?: string | null;
  value?: ValueLimit | null;
  /** Identity records that the rules read: the delegate's, the delegator agent's, and their ancestors. */
  records: Utxo[];
  /** Delegate keys of other live delegations: the SDKs refuse a key that another live delegation uses (§5.2 fresh keys). */
  inUseDelegateKeys?: readonly string[];
}

export interface DelegateTx extends UnsignedTx {
  delegationId: string;
  delegationOutput: number;
}

/** Delegate { seed }: mints the delegation token to DA with a checked datum. */
export function buildDelegate(ctx: TxContext, scripts: DelegationScripts, args: DelegateArgs): DelegateTx {
  if (paymentCredential(args.seed.address)?.type !== "VerificationKey") refuse("seed_not_key_locked", "the seed must be a key-locked UTxO");
  if (args.inUseDelegateKeys?.includes(args.delegateKey)) {
    refuse("delegate_key_in_use", "another live delegation uses this delegate key; use a fresh listed key");
  }
  const id = vectorIdFromSeed(args.seed.ref.txHash, args.seed.ref.index);
  const available = recordsById(scripts.identityHash, args.records);
  const references = new Map<string, Utxo>();
  const add = (u: Utxo): void => void references.set(`${u.ref.txHash}#${u.ref.index}`, u);
  const signers = new Set<string>([args.delegateKey]);

  const delegate = requireActive(available, args.delegate, "delegate", args.window);
  delegate.refs.forEach(add);
  if (!activeKey(delegate.record.datum, args.delegateKey, PURPOSE_DELEGATION)) {
    refuse("delegate_key_not_listed", "the delegate record does not list delegate_key as an Ed25519 key with the delegation purpose");
  }

  let delegator: Delegator;
  let depth: number;
  const actions = args.actions;
  const resources = args.resources;
  if (args.parent === undefined) {
    if (args.delegator === undefined) refuse("delegator_missing", "a delegation without a parent needs its delegator");
    delegator = args.delegator;
    depth = 1;
    if (delegator.type === "PrincipalKey") signers.add(delegator.hash);
    else {
      const agent = requireActive(available, delegator.id, "delegator", args.window);
      agent.refs.forEach(add);
      const signer = args.agentSigner ?? keyHash(agent.record.datum.controller);
      if (signer !== keyHash(agent.record.datum.controller) && !activeKey(agent.record.datum, signer, PURPOSE_DELEGATION)) {
        refuse("agent_signer_invalid", "the agent signs with its controller or a listed key with the delegation purpose");
      }
      signers.add(signer);
    }
  } else {
    if (args.delegator !== undefined) refuse("delegator_with_parent", "with a parent, the delegator is the parent's delegate; leave delegator out");
    const parent = readDelegation(scripts.delegation.hash, args.parent, "parent delegation");
    add(parent.utxo);
    delegator = { type: "Agent", id: parent.datum.delegate };
    if (parent.datum.remaining < 1) refuse("parent_no_hops", "the parent delegation allows no further hop");
    const agent = requireActive(available, parent.datum.delegate, "delegator", args.window);
    agent.refs.forEach(add);
    if (!activeKey(agent.record.datum, parent.datum.delegateKey, PURPOSE_DELEGATION)) {
      refuse("parent_key_not_listed", "the delegator agent no longer lists the parent's delegate key with the delegation purpose");
    }
    signers.add(parent.datum.delegateKey);
    if (!narrower(actions, parent.actions)) refuse("not_narrower", "the parent does not cover every action");
    if (!narrower(resources, parent.resources)) refuse("not_narrower", "the parent does not cover every resource");
    if (!(parent.datum.notBefore <= args.notBefore && args.notAfter <= parent.datum.notAfter)) refuse("not_narrower", "the period must be inside the parent's period");
    if (args.remaining > parent.datum.remaining - 1) refuse("not_narrower", `remaining must be at most ${parent.datum.remaining - 1}`);
    const p = parent.datum.value;
    const c = args.value ?? null;
    if (p !== null && (c === null || c.perTx > p.perTx || c.total > p.total || c.periodMs < p.periodMs)) {
      refuse("not_narrower", "the value limit must be inside the parent's limit");
    }
    depth = parent.datum.depth + 1;
  }

  const datum: DelegationDatum = {
    delegator,
    parent: args.parent === undefined ? null : readDelegation(scripts.delegation.hash, args.parent).id,
    delegate: args.delegate,
    delegateKey: args.delegateKey,
    actions: actions.map(utf8ToHex),
    resources: resources.map(utf8ToHex),
    notBefore: args.notBefore,
    notAfter: args.notAfter,
    depth,
    remaining: args.remaining,
    purpose: args.purpose ?? null,
    value: args.value ?? null,
  };
  const problems = delegationProblems(datum);
  if (problems.length > 0) refuse("delegation_invalid", `the delegation is not valid: ${problems.join("; ")}`);
  const shape = {
    address: enterpriseAddress({ type: "Script", hash: scripts.delegation.hash }, ctx.networkId),
    assets: [{ policy: scripts.delegation.hash, name: id, quantity: 1n }],
    datum: delegationDatumToData(datum),
    scriptRef: null,
  };
  const tx = completeTx(ctx, {
    inputs: [{ utxo: args.seed }],
    referenceInputs: [...references.values()],
    outputs: [{ ...shape, coin: coinForOutput(shape, ctx.protocol.coinsPerUtxoByte) }],
    mints: [{
      policy: scripts.delegation.hash,
      assets: [{ name: id, quantity: 1n }],
      redeemer: { data: delegationMintToData({ type: "Delegate", seed: args.seed.ref }), label: "delegation Delegate" },
      script: scripts.delegation,
    }],
    withdrawals: [],
    extraSignatories: [...signers],
    window: args.window,
  });
  return { ...tx, delegationId: id, delegationOutput: 0 };
}

// ─── Undelegate ──────────────────────────────────────────────────────

export interface UndelegateArgs {
  delegation: Utxo;
  window: ValidityWindow;
  /** Who signs: the delegator of this delegation or of an ancestor. An agent signs with its controller (default) or a listed delegation key. */
  revoker: { type: "PrincipalKey"; hash: string } | { type: "Agent"; id: string; signer?: string };
  /** The ancestor delegations up to the revoker's link (reference inputs). */
  ancestors?: Utxo[];
  /** The revoker agent's record (reference input). */
  records?: Utxo[];
}

/** Undelegate: burns the delegation token; the delegator of the delegation or of an ancestor signs. */
export function buildUndelegate(ctx: TxContext, scripts: DelegationScripts, args: UndelegateArgs): UnsignedTx {
  const spent = readDelegation(scripts.delegation.hash, args.delegation);
  const ancestors = new Map((args.ancestors ?? []).map((u, i) => {
    const d = readDelegation(scripts.delegation.hash, u, `ancestor delegation ${i}`);
    return [d.id, d] as const;
  }));
  const references: Utxo[] = [];
  let link = spent;
  for (let left = MAX_DEPTH; ; left -= 1) {
    const d = link.datum.delegator;
    const matches = args.revoker.type === "PrincipalKey"
      ? d.type === "PrincipalKey" && d.hash === args.revoker.hash
      : d.type === "Agent" && d.id === args.revoker.id;
    if (matches) break;
    if (link.datum.parent === null || left <= 1) refuse("revoker_not_delegator", "the revoker is not the delegator of this delegation or of an ancestor");
    const parent = ancestors.get(link.datum.parent);
    if (parent === undefined) refuse("delegation_ancestor_missing", `the parent delegation ${link.datum.parent} must be a reference input`);
    references.push(parent.utxo);
    link = parent;
  }
  let signer: string;
  if (args.revoker.type === "PrincipalKey") signer = args.revoker.hash;
  else {
    const record = recordsById(scripts.identityHash, args.records).get(args.revoker.id);
    if (record === undefined) refuse("record_missing", `the record of the revoker agent ${args.revoker.id} must be a reference input`);
    references.push(record.utxo);
    signer = args.revoker.signer ?? keyHash(record.datum.controller);
    if (signer !== keyHash(record.datum.controller) && !activeKey(record.datum, signer, PURPOSE_DELEGATION)) {
      refuse("agent_signer_invalid", "the agent signs with its controller or a listed key with the delegation purpose");
    }
  }
  const undelegate = delegationMintToData({ type: "Undelegate" });
  return completeTx(ctx, {
    inputs: [{ utxo: spent.utxo, redeemer: { data: undelegate, label: "delegation Undelegate (spend)" }, script: scripts.delegation }],
    referenceInputs: references,
    outputs: [],
    mints: [{
      policy: scripts.delegation.hash,
      assets: [{ name: spent.id, quantity: -1n }],
      redeemer: { data: undelegate, label: "delegation Undelegate (burn)" },
      script: scripts.delegation,
    }],
    withdrawals: [],
    extraSignatories: [signer],
    window: args.window,
  });
}
