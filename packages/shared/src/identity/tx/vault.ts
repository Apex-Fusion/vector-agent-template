/**
 * Transaction builders of the vault contract (Part 2 §5.3): the funding
 * output (open), Pay into new-layout escrows with the vault refund, and Close
 * of Live and Returned outputs. The rules follow
 * `contracts/identity-marketplace/lib/identity_marketplace/vault/handlers.ak`.
 */

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import { decodeVaultDatum, encodeVaultSpend, vaultDatumToData, type Delegator, type VaultDatum } from "../../cbor/Delegation.js";
import { identityEscrowDatumToData, type IdentityEscrowDatum } from "../../cbor/IdentityEscrowDatum.js";
import { decodePlutusDataHex } from "../../cbor/plutus-data.js";
import { DAYS_7_MS, MAX_ESCROW_LOVELACE } from "../constants.js";
import { keyHash } from "../id.js";
import { completeTx } from "./complete.js";
import { delegationUse, escrowResource, HIRE_ACTION, patternsCover, readDelegation } from "./delegation.js";
import { coinForOutput, enterpriseAddress, isEnterpriseAddressOf, minUtxo, utxoAssets, type TxOutput } from "./ledger.js";
import { readRecord } from "./records.js";
import { refuse, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow } from "./types.js";

export interface VaultScripts {
  /** The applied vault validator; VA is its enterprise address. */
  vault: ScriptSource;
  /** The vault parameters: identity, delegation and escrow script hashes. */
  identityHash: string;
  delegationHash: string;
  escrowHash: string;
}

const PAY = decodePlutusDataHex(encodeVaultSpend({ type: "Pay" }));
const CLOSE = decodePlutusDataHex(encodeVaultSpend({ type: "Close" }));

const sameDelegator = (a: Delegator, b: Delegator): boolean =>
  a.type === "PrincipalKey" && b.type === "PrincipalKey"
    ? a.hash === b.hash && a.organisation === b.organisation
    : a.type === "Agent" && b.type === "Agent" && a.id === b.id;

const vaultAddress = (ctx: TxContext, scripts: VaultScripts): string =>
  enterpriseAddress({ type: "Script", hash: scripts.vault.hash }, ctx.networkId);

function vaultOutput(ctx: TxContext, scripts: VaultScripts, datum: VaultDatum, coin: bigint): TxOutput {
  return { address: vaultAddress(ctx, scripts), coin, assets: [], datum: vaultDatumToData(datum), scriptRef: null };
}

function readVault(scripts: VaultScripts, utxo: Utxo): { utxo: Utxo; datum: VaultDatum } {
  const where = `vault ${utxo.ref.txHash}#${utxo.ref.index}`;
  if (!isEnterpriseAddressOf(utxo.address, { type: "Script", hash: scripts.vault.hash })) refuse("vault_address", `${where} is not at the vault address`);
  if (utxo.datumHex === null) refuse("vault_datum_missing", `${where} has no inline datum`);
  return { utxo, datum: decodeVaultDatum(utxo.datumHex) };
}

/**
 * The funding output of a vault: AP3X at VA with `Live { owner, delegation,
 * spent: 0, period_start: 0 }`, so the first Pay starts a period. No script
 * runs. The builder checks that the delegation can pay from the vault: its
 * delegator is the owner, it has a value limit, and it covers the hire action
 * and the escrow resource.
 */
export function buildVaultOpen(
  ctx: TxContext,
  scripts: VaultScripts,
  args: { owner: Delegator; delegation: Utxo; amount: bigint; window: ValidityWindow },
): UnsignedTx & { vaultOutput: number } {
  const delegation = readDelegation(scripts.delegationHash, args.delegation);
  if (!sameDelegator(delegation.datum.delegator, args.owner)) refuse("vault_owner_mismatch", "the delegation's delegator must be the vault owner");
  if (delegation.datum.value === null) refuse("vault_no_limit", "a vault delegation needs a value limit");
  if (!patternsCover(delegation.actions, HIRE_ACTION)) refuse("action_not_covered", `the delegation does not cover ${HIRE_ACTION}`);
  if (!patternsCover(delegation.resources, escrowResource(scripts.escrowHash))) {
    refuse("resource_not_covered", `the delegation does not cover ${escrowResource(scripts.escrowHash)}`);
  }
  const datum: VaultDatum = { type: "Live", owner: args.owner, delegation: delegation.id, spent: 0n, periodStart: 0 };
  const output = vaultOutput(ctx, scripts, datum, args.amount);
  if (args.amount < coinForOutput(output, ctx.protocol.coinsPerUtxoByte)) refuse("vault_amount_too_low", "the vault amount is below the min-UTxO");
  const tx = completeTx(ctx, { inputs: [], referenceInputs: [], outputs: [output], mints: [], withdrawals: [], extraSignatories: [], window: args.window });
  return { ...tx, vaultOutput: 0 };
}

/** One new escrow of a vault payment (§5.3, §6.1). The builder sets the buyer, the state and the refund. */
export interface VaultEscrowJob {
  supplierPkh: string;
  advertRef: OutputReference;
  /** Text. */
  capabilityId: string;
  requestSpecHash: string;
  promptHash: string;
  payment: bigint;
  /** The builder raises it when payment + bonds is below the min-UTxO of the escrow output (see `buildVaultPay`). */
  buyerBond: bigint;
  supplierBond: bigint;
  /** At most hi + 7 days. */
  deliverBy: number;
  /** Default: lo. */
  postedAt?: number;
  /** The agent of a listed advert (32 bytes). */
  agentId: string;
}

export interface VaultPayArgs {
  /** A Live vault output that holds AP3X only. */
  vault: Utxo;
  window: ValidityWindow;
  /** The ancestors of the vault's delegation (reference inputs). The vault's delegation itself comes from `delegation`. */
  delegation: Utxo;
  ancestors?: Utxo[];
  /** Identity records that the use checks read: each delegate's record, a root agent delegator's record, and their ancestors. */
  records: Utxo[];
  escrows: VaultEscrowJob[];
}

/** Pay: moves AP3X from a Live vault into new escrows whose refunds return to VA as Returned outputs. */
export function buildVaultPay(ctx: TxContext, scripts: VaultScripts, args: VaultPayArgs): UnsignedTx & { escrowOutputs: number[]; vaultOutput: number } {
  const vault = readVault(scripts, args.vault);
  if (vault.datum.type !== "Live") refuse("vault_returned", "Pay needs a Live vault output; Returned outputs only close");
  const live = vault.datum;
  if (utxoAssets(vault.utxo).length > 0) refuse("vault_assets", "Pay needs a vault output that holds AP3X only");
  const use = delegationUse({
    identityHash: scripts.identityHash,
    delegationHash: scripts.delegationHash,
    leaf: args.delegation,
    ancestors: args.ancestors ?? [],
    records: args.records,
    action: HIRE_ACTION,
    resource: escrowResource(scripts.escrowHash),
    window: args.window,
  });
  const leaf = use.leaf;
  if (leaf.id !== live.delegation) refuse("vault_delegation_mismatch", `the vault uses delegation ${live.delegation}, not ${leaf.id}`);
  if (!sameDelegator(leaf.datum.delegator, live.owner)) refuse("vault_owner_mismatch", "the delegation's delegator must be the vault owner");
  const limit = leaf.datum.value;
  if (limit === null) refuse("vault_no_limit", "the vault's delegation has no value limit");
  if (args.escrows.length === 0) refuse("vault_no_escrow", "Pay needs at least one escrow");

  const { lo, hi } = args.window;
  const refund = {
    address: { paymentCredential: { type: "Script" as const, hash: scripts.vault.hash }, stakeCredential: null },
    datum: vaultDatumToData({ type: "Returned", owner: live.owner }),
  };
  const escrowAddress = enterpriseAddress({ type: "Script", hash: scripts.escrowHash }, ctx.networkId);
  // Each escrow output holds exactly payment + buyer bond + supplier bond in AP3X. When that sum is
  // below the ledger min-UTxO of the output, the buyer bond takes the difference: the buyer funds
  // all three amounts, and every refund returns them (§6.1).
  const outputs: TxOutput[] = args.escrows.map((job, i) => {
    if (job.payment < 0n || job.buyerBond < 0n || job.supplierBond < 0n) refuse("escrow_negative", `escrow ${i}: amounts must be 0 or more`);
    if (job.deliverBy > hi + DAYS_7_MS) refuse("escrow_deliver_by", `escrow ${i}: deliver_by must be at most hi + 7 days (${hi + DAYS_7_MS})`);
    const datum: IdentityEscrowDatum = {
      buyer_pkh: leaf.datum.delegateKey,
      supplier_pkh: job.supplierPkh,
      advert_ref: job.advertRef,
      capability_id: job.capabilityId,
      request_spec_hash: job.requestSpecHash,
      prompt_hash: job.promptHash,
      payment_lovelace: job.payment,
      buyer_bond_lovelace: job.buyerBond,
      supplier_bond_lovelace: job.supplierBond,
      deliver_by: job.deliverBy,
      posted_at: job.postedAt ?? lo,
      submitted_at: null,
      result_receipt_hash: null,
      state: "Open",
      agent_id: job.agentId,
      refund,
    };
    for (let round = 0; round < 8; round += 1) {
      const total = datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace;
      const output: TxOutput = { address: escrowAddress, coin: total, assets: [], datum: identityEscrowDatumToData(datum), scriptRef: null };
      const needed = minUtxo(output, ctx.protocol.coinsPerUtxoByte);
      if (total >= needed) {
        if (total > MAX_ESCROW_LOVELACE) refuse("escrow_over_cap", `escrow ${i}: payment + bonds exceed 10,000 AP3X`);
        return output;
      }
      datum.buyer_bond_lovelace += needed - total;
    }
    return refuse("escrow_min_utxo", `escrow ${i}: the buyer bond does not settle at the min-UTxO`);
  });
  const amount = outputs.reduce((t, o) => t + o.coin, 0n);
  if (amount > limit.perTx) refuse("vault_per_tx", `the payment of ${amount} exceeds per_tx ${limit.perTx}`);
  const newPeriod = lo >= live.periodStart + limit.periodMs;
  const spent = newPeriod ? amount : live.spent + amount;
  if (spent > limit.total) refuse("vault_total", `the period total would be ${spent}; the limit is ${limit.total}`);
  const next: VaultDatum = { type: "Live", owner: live.owner, delegation: live.delegation, spent, periodStart: newPeriod ? hi : live.periodStart };
  const continuing = vaultOutput(ctx, scripts, next, vault.utxo.lovelace - amount);
  if (continuing.coin < coinForOutput(continuing, ctx.protocol.coinsPerUtxoByte)) {
    refuse("vault_too_small", `the vault keeps ${continuing.coin}, below the min-UTxO; pay less or close the vault`);
  }
  const tx = completeTx(ctx, {
    inputs: [{ utxo: vault.utxo, redeemer: { data: PAY, label: "vault Pay" }, script: scripts.vault }],
    referenceInputs: use.references,
    outputs: [...outputs, continuing],
    mints: [],
    withdrawals: [],
    extraSignatories: [leaf.datum.delegateKey],
    window: args.window,
  });
  return { ...tx, escrowOutputs: outputs.map((_, i) => i), vaultOutput: outputs.length };
}

/**
 * Close: the owner takes Live and Returned outputs, also after Undelegate. A
 * principal key signs; for an agent owner, its controller signs with its
 * record as a reference input. The funds go to `to`, or to the change address.
 */
export function buildVaultClose(
  ctx: TxContext,
  scripts: VaultScripts,
  args: { vaults: Utxo[]; window: ValidityWindow; ownerRecords?: Utxo[]; to?: string },
): UnsignedTx {
  if (args.vaults.length === 0) refuse("vault_missing", "Close needs at least one vault output");
  const signers = new Set<string>();
  const references = new Map<string, Utxo>();
  const records = new Map((args.ownerRecords ?? []).map((u) => {
    const r = readRecord(u, scripts.identityHash, "owner record");
    return [r.id, r] as const;
  }));
  for (const utxo of args.vaults) {
    const owner = readVault(scripts, utxo).datum.owner;
    if (owner.type === "PrincipalKey") signers.add(owner.hash);
    else {
      const record = records.get(owner.id);
      if (record === undefined) refuse("record_missing", `the record of the owner agent ${owner.id} must be a reference input`);
      references.set(`${record.utxo.ref.txHash}#${record.utxo.ref.index}`, record.utxo);
      signers.add(keyHash(record.datum.controller));
    }
  }
  const total = args.vaults.reduce((t, u) => t + u.lovelace, 0n);
  return completeTx(ctx, {
    inputs: args.vaults.map((utxo, i) => ({ utxo, redeemer: { data: CLOSE, label: `vault Close ${i}` }, script: scripts.vault })),
    referenceInputs: [...references.values()],
    outputs: args.to === undefined ? [] : [{ address: args.to, coin: total, assets: [], datum: null, scriptRef: null }],
    mints: [],
    withdrawals: [],
    extraSignatories: [...signers],
    window: args.window,
  });
}
