/**
 * From a transaction plan to an unsigned Conway transaction: coin selection
 * from the wallet, the change output, collateral, redeemer pointers and
 * execution units, the script data hash and the fee.
 *
 * The builders of each action make a `TxPlan` that holds exactly what the
 * contract rules need. This module adds only key-locked wallet inputs, one
 * change output and collateral, so the plan's rules stay true: the wallet
 * inputs are not script inputs, and the change goes to the caller.
 */

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import { encodePlutusDataHex, type PlutusData } from "../../cbor/plutus-data.js";
import { MAX_RANGE_MS } from "../constants.js";
import {
  blake2b256Hex, bytesToHex, coinForOutput, compareHex, compareOutRefs, compareRewardAccounts, encodeBody,
  encodeRedeemers, encodeTransaction, encodeWitnessSet, executionFee, minUtxo, normaliseAssets,
  paymentCredential, plutusV3Hash, referenceScriptFee, rewardAddressBytes, scriptDataHash, utxoAssets,
  type Credential, type EncodedRedeemer, type ExUnits, type TxAsset, type TxBody, type TxOutput, type VKeyWitness,
} from "./ledger.js";
import {
  refuse, type BuiltRedeemer, type ScriptSource, type SlotConfig, type TxContext, type UnsignedTx, type ValidityWindow,
} from "./types.js";

export interface PlannedRedeemer {
  data: PlutusData;
  label: string;
}

export interface PlannedInput {
  utxo: Utxo;
  /** Required for a script-locked input. */
  redeemer?: PlannedRedeemer;
  /** The script of a script-locked input. */
  script?: ScriptSource;
}

export interface PlannedMint {
  policy: string;
  assets: Array<{ name: string; quantity: bigint }>;
  redeemer: PlannedRedeemer;
  script: ScriptSource;
}

export interface PlannedWithdrawal {
  /** A script stake credential (for example Module-1 `identity_party`). */
  credential: Extract<Credential, { type: "Script" }>;
  amount: bigint;
  redeemer: PlannedRedeemer;
  script: ScriptSource;
}

export interface TxPlan {
  inputs: PlannedInput[];
  /** Data reference inputs (records, configuration, delegations). Reference scripts are added from the sources. */
  referenceInputs: Utxo[];
  /** The planned outputs, in order. The change output comes after them. */
  outputs: TxOutput[];
  mints: PlannedMint[];
  withdrawals: PlannedWithdrawal[];
  /** Key hashes for the body's `required_signers`. */
  extraSignatories: string[];
  window: ValidityWindow;
  /** The change output must exist and hold at least this coin (the legacy change rule of Adopt). */
  changeMin?: bigint;
}

const refKey = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

// ─── Validity window ─────────────────────────────────────────────────

/** The slot that starts at `ms`; refuses a time that is not a slot start. */
export function slotAt(ms: number, slots: SlotConfig): bigint {
  const offset = ms - slots.zeroTimeMs;
  if (!Number.isSafeInteger(ms) || offset < 0 || offset % slots.slotLengthMs !== 0) {
    refuse("window_not_slot_aligned", `validity bound ${ms} is not the start of a slot (zero time ${slots.zeroTimeMs}, slot length ${slots.slotLengthMs} ms)`);
  }
  return BigInt(slots.zeroSlot + offset / slots.slotLengthMs);
}

/** The window rules of every identity, attestation, delegation and vault transaction: lo < hi and hi − lo ≤ 1 hour. */
export function checkWindow(window: ValidityWindow, slots: SlotConfig): { start: bigint; ttl: bigint } {
  const start = slotAt(window.lo, slots);
  const ttl = slotAt(window.hi, slots);
  if (window.hi <= window.lo) refuse("window_empty", `validity window [${window.lo}, ${window.hi}] is empty`);
  if (window.hi - window.lo > MAX_RANGE_MS) {
    refuse("window_too_long", `validity window is ${window.hi - window.lo} ms; the contracts allow at most ${MAX_RANGE_MS} ms`);
  }
  return { start, ttl };
}

/**
 * A slot-aligned window around `nowMs`: from `pastMs` before it (default
 * 60 s) to `futureMs` after it (default 10 min). Several rules take values
 * from the window (created_at = hi, a hold's since = lo), so build the window
 * first and pass the same value to the builder.
 */
export function validityWindow(
  nowMs: number,
  slots: SlotConfig,
  options: { pastMs?: number; futureMs?: number } = {},
): ValidityWindow {
  const floor = (ms: number): number =>
    slots.zeroTimeMs + Math.floor((ms - slots.zeroTimeMs) / slots.slotLengthMs) * slots.slotLengthMs;
  const lo = floor(nowMs - (options.pastMs ?? 60_000));
  const hi = floor(nowMs + (options.futureMs ?? 600_000));
  checkWindow({ lo, hi }, slots);
  return { lo, hi };
}

// ─── Scripts ─────────────────────────────────────────────────────────

/** Checks that a script source matches its hash. */
export function checkScriptSource(source: ScriptSource, label: string): void {
  if (source.compiledCode !== undefined) {
    if (plutusV3Hash(source.compiledCode) !== source.hash) {
      refuse("script_hash_mismatch", `${label}: the compiled code hashes to ${plutusV3Hash(source.compiledCode)}, not ${source.hash}`);
    }
    return;
  }
  const code = source.referenceUtxo.scriptRef;
  if (code === null) refuse("script_reference_missing", `${label}: reference UTxO ${refKey(source.referenceUtxo.ref)} holds no reference script`);
  if (plutusV3Hash(code) !== source.hash) {
    refuse("script_hash_mismatch", `${label}: reference UTxO ${refKey(source.referenceUtxo.ref)} holds script ${plutusV3Hash(code)}, not ${source.hash}`);
  }
}

// ─── Completion ──────────────────────────────────────────────────────

interface Selection {
  inputs: Utxo[];
  change: TxOutput | null;
}

function keyHashOf(address: string): string | null {
  const credential = paymentCredential(address);
  return credential !== null && credential.type === "VerificationKey" ? credential.hash : null;
}

function sumCoin(utxos: readonly Utxo[]): bigint {
  return utxos.reduce((total, u) => total + u.lovelace, 0n);
}

function costModelList(costModel: ProtocolCostModel): number[] {
  return Array.isArray(costModel) ? [...costModel] : Object.values(costModel);
}

type ProtocolCostModel = TxContext["protocol"]["costModels"]["PlutusV3"];

/**
 * Completes a plan into an unsigned transaction. Refuses when the wallet
 * cannot pay, when the transaction is too large, or when the execution units
 * exceed the transaction limit.
 */
export function completeTx(ctx: TxContext, plan: TxPlan): UnsignedTx {
  const { protocol, slotConfig, networkId } = ctx;
  const { start, ttl } = checkWindow(plan.window, slotConfig);
  if (paymentCredential(ctx.changeAddress) === null) {
    refuse("change_address_invalid", `change address ${ctx.changeAddress} has no payment credential`);
  }

  // Scripts: inline ones go to the witness set, reference ones add their UTxO.
  const sources = new Map<string, ScriptSource>();
  const addSource = (source: ScriptSource, label: string): void => {
    checkScriptSource(source, label);
    if (!sources.has(source.hash)) sources.set(source.hash, source);
  };
  for (const input of plan.inputs) {
    const credential = paymentCredential(input.utxo.address);
    if (credential === null) refuse("input_address_invalid", `input ${refKey(input.utxo.ref)} has no payment credential`);
    if (credential.type === "Script") {
      if (input.redeemer === undefined || input.script === undefined) {
        refuse("script_input_without_redeemer", `script input ${refKey(input.utxo.ref)} needs a redeemer and its script`);
      }
      if (input.script.hash !== credential.hash) {
        refuse("script_hash_mismatch", `input ${refKey(input.utxo.ref)} is locked by ${credential.hash}, not by ${input.script.hash}`);
      }
      addSource(input.script, input.redeemer.label);
    } else if (input.redeemer !== undefined) {
      refuse("key_input_with_redeemer", `key-locked input ${refKey(input.utxo.ref)} takes no redeemer`);
    }
  }
  for (const mint of plan.mints) {
    if (mint.script.hash !== mint.policy) refuse("script_hash_mismatch", `mint of ${mint.policy} with script ${mint.script.hash}`);
    addSource(mint.script, mint.redeemer.label);
  }
  for (const w of plan.withdrawals) {
    if (w.script.hash !== w.credential.hash) refuse("script_hash_mismatch", `withdrawal of ${w.credential.hash} with script ${w.script.hash}`);
    addSource(w.script, w.redeemer.label);
  }
  const inlineScripts = [...sources.values()]
    .filter((s): s is Extract<ScriptSource, { compiledCode: string }> => s.compiledCode !== undefined)
    .sort((a, b) => compareHex(a.hash, b.hash))
    .map((s) => s.compiledCode);

  // Reference inputs: data references and reference scripts, without duplicates.
  const referenceMap = new Map<string, Utxo>();
  for (const utxo of plan.referenceInputs) referenceMap.set(refKey(utxo.ref), utxo);
  for (const source of sources.values()) {
    if (source.referenceUtxo !== undefined) referenceMap.set(refKey(source.referenceUtxo.ref), source.referenceUtxo);
  }
  const fixedKeys = new Set(plan.inputs.map((i) => refKey(i.utxo.ref)));
  if (fixedKeys.size !== plan.inputs.length) refuse("duplicate_input", "the plan spends an input twice");
  for (const key of referenceMap.keys()) {
    if (fixedKeys.has(key)) refuse("reference_input_spent", `UTxO ${key} is both spent and a reference input`);
  }
  const referenceInputs = [...referenceMap.values()].sort((a, b) => compareOutRefs(a.ref, b.ref));

  // Wallet candidates: key-locked, not already used, no reference script; AP3X-only first, then most AP3X.
  const candidates = ctx.wallet
    .filter((u) => !fixedKeys.has(refKey(u.ref)) && !referenceMap.has(refKey(u.ref)))
    .filter((u) => keyHashOf(u.address) !== null && u.scriptRef === null)
    .sort((a, b) => {
      const tokensA = Object.keys(a.assets).length > 0 ? 1 : 0;
      const tokensB = Object.keys(b.assets).length > 0 ? 1 : 0;
      return tokensA - tokensB || (b.lovelace > a.lovelace ? 1 : b.lovelace < a.lovelace ? -1 : 0) || compareOutRefs(a.ref, b.ref);
    });

  const mintAssets: TxAsset[] = plan.mints.flatMap((m) => m.assets.map((a) => ({ policy: m.policy, name: a.name, quantity: a.quantity })));
  const withdrawals = plan.withdrawals
    .map((w) => ({ plan: w, rewardAccount: rewardAddressBytes(w.credential, networkId) }))
    .sort((a, b) => compareRewardAccounts(a.rewardAccount, b.rewardAccount));
  const withdrawn = withdrawals.reduce((total, w) => total + w.plan.amount, 0n);
  const changeMin = plan.changeMin ?? 0n;

  const select = (fee: bigint): Selection => {
    const chosen: Utxo[] = [];
    for (let next = 0; ; next += 1) {
      const spent = [...plan.inputs.map((i) => i.utxo), ...chosen];
      const coin = sumCoin(spent) + withdrawn - plan.outputs.reduce((t, o) => t + o.coin, 0n) - fee;
      const assets = normaliseAssets([
        ...spent.flatMap(utxoAssets),
        ...mintAssets,
        ...plan.outputs.flatMap((o) => o.assets.map((a) => ({ ...a, quantity: -a.quantity }))),
      ]);
      const missing = assets.filter((a) => a.quantity < 0n);
      if (missing.length > 0) {
        refuse("asset_missing", `no input holds ${missing.map((a) => `${-a.quantity} of ${a.policy}.${a.name}`).join(", ")}`);
      }
      let shortfall = 0n;
      let change: TxOutput | null = null;
      if (coin !== 0n || assets.length > 0 || changeMin > 0n) {
        const shape = { address: ctx.changeAddress, assets, datum: null, scriptRef: null };
        // The least coin that meets the min-UTxO and changeMin; with more coin, its own encoding size counts.
        const least = coinForOutput(shape, protocol.coinsPerUtxoByte, changeMin);
        const needed = coin > least ? minUtxo({ ...shape, coin }, protocol.coinsPerUtxoByte) : least;
        shortfall = needed - coin;
        change = { ...shape, coin };
      }
      if (shortfall <= 0n) return { inputs: chosen, change };
      const candidate = candidates[next];
      if (candidate === undefined) {
        refuse("insufficient_funds", `the wallet is short by ${shortfall} base units (fee ${fee}${changeMin > 0n ? `, change at least ${changeMin}` : ""})`);
      }
      chosen.push(candidate);
    }
  };

  // Redeemers in ledger order, with pointers into the sorted inputs, policies and accounts.
  const redeemerCount = plan.inputs.filter((i) => i.redeemer !== undefined).length + plan.mints.length + plan.withdrawals.length;
  const given = ctx.exUnits ?? {};

  const build = (fee: bigint, selection: Selection, collateral: CollateralChoice | null) => {
    const spent = [...plan.inputs.map((i) => i.utxo), ...selection.inputs].sort((a, b) => compareOutRefs(a.ref, b.ref));
    const pointers: Array<{ tag: "spend" | "mint" | "withdraw"; index: number; redeemer: PlannedRedeemer }> = [];
    spent.forEach((utxo, index) => {
      const planned = plan.inputs.find((i) => refKey(i.utxo.ref) === refKey(utxo.ref));
      if (planned?.redeemer !== undefined) pointers.push({ tag: "spend", index, redeemer: planned.redeemer });
    });
    const policies = [...new Set(plan.mints.map((m) => m.policy))].sort(compareHex);
    if (policies.length !== plan.mints.length) refuse("duplicate_mint_policy", "the plan mints one policy twice");
    for (const mint of plan.mints) pointers.push({ tag: "mint", index: policies.indexOf(mint.policy), redeemer: mint.redeemer });
    withdrawals.forEach((w, index) => pointers.push({ tag: "withdraw", index, redeemer: w.plan.redeemer }));
    pointers.sort((a, b) => ORDER[a.tag] - ORDER[b.tag] || a.index - b.index);

    const missing = pointers.filter((p) => given[`${p.tag}:${p.index}`] === undefined).length;
    let freeMem = protocol.maxTxExMem;
    let freeSteps = protocol.maxTxExSteps;
    for (const p of pointers) {
      const units = given[`${p.tag}:${p.index}`];
      if (units !== undefined) {
        freeMem -= units.mem;
        freeSteps -= units.steps;
      }
    }
    const share: ExUnits = missing === 0
      ? { mem: 0n, steps: 0n }
      : { mem: freeMem / BigInt(missing), steps: freeSteps / BigInt(missing) };
    const redeemers: EncodedRedeemer[] = pointers.map((p) => ({
      tag: p.tag,
      index: p.index,
      data: p.redeemer.data,
      exUnits: given[`${p.tag}:${p.index}`] ?? share,
    }));
    const total = redeemers.reduce((t, r) => ({ mem: t.mem + r.exUnits.mem, steps: t.steps + r.exUnits.steps }), { mem: 0n, steps: 0n });
    if (total.mem > protocol.maxTxExMem || total.steps > protocol.maxTxExSteps || total.mem < 0n || total.steps < 0n) {
      refuse("execution_units_too_high", `the redeemers need ${total.mem} memory and ${total.steps} steps; the limit is ${protocol.maxTxExMem} and ${protocol.maxTxExSteps}`);
    }
    const redeemerBytes = redeemers.length > 0 ? encodeRedeemers(redeemers) : null;

    const outputs = selection.change === null ? [...plan.outputs] : [...plan.outputs, selection.change];
    const body: TxBody = {
      inputs: spent.map((u) => u.ref),
      outputs,
      fee,
      ttl,
      withdrawals: withdrawals.map((w) => ({ rewardAccount: w.rewardAccount, amount: w.plan.amount })),
      validityStart: start,
      mint: normaliseAssets(mintAssets),
      scriptDataHash: redeemerBytes === null ? null : scriptDataHash(redeemerBytes, costModelList(protocol.costModels.PlutusV3)),
      collateral: collateral === null ? [] : collateral.inputs.map((u) => u.ref).sort(compareOutRefs),
      requiredSigners: [...new Set(plan.extraSignatories)].sort(compareHex),
      collateralReturn: collateral?.collateralReturn ?? null,
      totalCollateral: collateral?.total ?? null,
      referenceInputs: referenceInputs.map((u) => u.ref),
    };
    const bodyBytes = encodeBody(body);
    const signers = new Set<string>(body.requiredSigners);
    for (const u of [...spent, ...(collateral?.inputs ?? [])]) {
      const hash = keyHashOf(u.address);
      if (hash !== null) signers.add(hash);
    }
    const fakeWitnesses: VKeyWitness[] = [...signers].map(() => ({ vkey: "00".repeat(32), signature: "00".repeat(64) }));
    const signedSize = encodeTransaction(bodyBytes, encodeWitnessSet({ vkeys: fakeWitnesses, redeemers: redeemerBytes, scripts: inlineScripts })).length;
    const refScriptBytes = [...spent, ...referenceInputs].reduce((t, u) => t + (u.scriptRef === null ? 0 : u.scriptRef.length / 2), 0);
    const minFee = BigInt(protocol.minFeeA) * BigInt(signedSize) + BigInt(protocol.minFeeB)
      + executionFee(protocol.priceMem, protocol.priceStep, total)
      + referenceScriptFee(protocol.minFeeRefScriptCostPerByte, refScriptBytes);
    return { body, bodyBytes, redeemers, redeemerBytes, signers, signedSize, minFee, spent, pointers };
  };

  let fee = 0n;
  for (let round = 0; round < 10; round += 1) {
    const selection = select(fee);
    const collateral = redeemerCount > 0 ? chooseCollateral(ctx, fee) : null;
    const draft = build(fee, selection, collateral);
    if (draft.minFee <= fee) {
      if (draft.signedSize > protocol.maxTxSize) {
        refuse("tx_too_large", `the signed transaction has ${draft.signedSize} bytes; the limit is ${protocol.maxTxSize}`);
      }
      const txBytes = encodeTransaction(draft.bodyBytes, encodeWitnessSet({ vkeys: [], redeemers: draft.redeemerBytes, scripts: inlineScripts }));
      const txHash = blake2b256Hex(draft.bodyBytes);
      return {
        txCborHex: bytesToHex(txBytes),
        txHash,
        requiredSigners: [...draft.signers].sort(compareHex),
        extraSignatories: draft.body.requiredSigners,
        referenceInputs: draft.body.referenceInputs,
        inputs: draft.body.inputs,
        outputs: draft.body.outputs.map((o, index) => toUtxo(o, { txHash, index })),
        fee,
        window: plan.window,
        redeemers: draft.redeemers.map((r): BuiltRedeemer => ({
          tag: r.tag,
          index: r.index,
          label: draft.pointers.find((p) => p.tag === r.tag && p.index === r.index)!.redeemer.label,
          exUnits: r.exUnits,
        })),
        signedSize: draft.signedSize,
      };
    }
    fee = draft.minFee;
  }
  return refuse("fee_not_stable", "the fee did not settle after 10 rounds");
}

const ORDER = { spend: 0, mint: 1, withdraw: 2 } as const;

interface CollateralChoice {
  inputs: Utxo[];
  total: bigint;
  collateralReturn: TxOutput | null;
}

/** Collateral: AP3X-only key-locked UTxOs, the most AP3X first, with a return output for the excess. */
function chooseCollateral(ctx: TxContext, fee: bigint): CollateralChoice {
  const { protocol } = ctx;
  const total = (fee * BigInt(protocol.collateralPercentage) + 99n) / 100n;
  const pool = [...(ctx.collateral ?? ctx.wallet)]
    .filter((u) => keyHashOf(u.address) !== null && Object.keys(u.assets).length === 0 && u.scriptRef === null)
    .sort((a, b) => (b.lovelace > a.lovelace ? 1 : b.lovelace < a.lovelace ? -1 : 0) || compareOutRefs(a.ref, b.ref));
  const chosen: Utxo[] = [];
  for (const utxo of pool) {
    if (chosen.length >= protocol.maxCollateralInputs) break;
    chosen.push(utxo);
    const sum = sumCoin(chosen);
    if (sum === total) return { inputs: chosen, total, collateralReturn: null };
    const back: TxOutput = { address: ctx.changeAddress, coin: sum - total, assets: [], datum: null, scriptRef: null };
    if (sum > total && back.coin >= minUtxo(back, protocol.coinsPerUtxoByte)) return { inputs: chosen, total, collateralReturn: back };
  }
  return refuse("collateral_missing", `no AP3X-only key-locked UTxOs cover the collateral of ${total} base units plus a return output`);
}

/** A created output as a chain UTxO. */
export function toUtxo(output: TxOutput, ref: OutputReference): Utxo {
  const assets: Record<string, bigint> = {};
  for (const a of output.assets) assets[`${a.policy}${a.name}`] = a.quantity;
  return {
    ref,
    address: output.address,
    lovelace: output.coin,
    assets,
    datumHex: output.datum === null ? null : encodePlutusDataHex(output.datum),
    scriptRef: output.scriptRef,
  };
}
