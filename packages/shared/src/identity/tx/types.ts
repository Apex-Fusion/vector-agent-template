/**
 * Public types of the identity transaction builders (Part 2 §3–§5, §9.1, §10).
 *
 * Every builder is a pure function: it takes UTxOs, records, keys and script
 * parameters, and it returns an unsigned Conway transaction, the key hashes
 * that must sign it and the reference inputs that it reads. It reads no
 * network and no clock. Each key holder signs the transaction ID in turn
 * (`addVKeyWitnesses`).
 */

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { NetworkId } from "../../network.js";
import { TxConstructionError } from "../../tx/types.js";
import type { ExUnits, RedeemerTag, TxOutput } from "./ledger.js";

export type { ExUnits, RedeemerTag, TxOutput };

/** Slot clock of the chain: a script sees slot `s` as `zeroTimeMs + (s - zeroSlot) × slotLengthMs`. */
export interface SlotConfig {
  zeroTimeMs: number;
  zeroSlot: number;
  slotLengthMs: number;
}

/** Vector mainnet (Part 1 §4): system start 2025-08-29T16:40:00Z, one slot per second. */
export const VECTOR_MAINNET_SLOT_CONFIG: SlotConfig = { zeroTimeMs: 1_756_485_600_000, zeroSlot: 0, slotLengthMs: 1000 };

/**
 * The protocol parameters that the builders use. The shape is a subset of
 * lucid-evolution's `ProtocolParameters`, so the value that
 * `OgmiosLucidProvider` returns fits as it is.
 */
export interface ProtocolParameters {
  /** Fee per transaction byte. */
  minFeeA: number;
  /** Constant fee per transaction. */
  minFeeB: number;
  /** Price of one memory unit (for example 0.0577). */
  priceMem: number;
  /** Price of one CPU step (for example 0.0000721). */
  priceStep: number;
  coinsPerUtxoByte: bigint;
  collateralPercentage: number;
  maxCollateralInputs: number;
  maxTxSize: number;
  maxTxExMem: bigint;
  maxTxExSteps: bigint;
  /** Conway reference-script fee per byte of the first 25,600-byte tier. */
  minFeeRefScriptCostPerByte: number;
  /** The Plutus V3 cost model in ledger order (a list, or a record in that order). */
  costModels: { PlutusV3: Readonly<Record<string, number>> | readonly number[] };
}

/**
 * Where a script comes from. A reference UTxO keeps the transaction small;
 * the identity script alone is about 13.5 KB. `hash` is the script hash
 * (= policy ID) and must match the code.
 */
export type ScriptSource =
  | { hash: string; compiledCode: string; referenceUtxo?: undefined }
  | { hash: string; referenceUtxo: Utxo; compiledCode?: undefined };

/** The validity window that the scripts see, in POSIX milliseconds: [lo, hi]. Both are slot starts. */
export interface ValidityWindow {
  lo: number;
  hi: number;
}

/** The context that every builder needs. */
export interface TxContext {
  networkId: NetworkId;
  slotConfig: SlotConfig;
  protocol: ProtocolParameters;
  /**
   * Wallet UTxOs (key-locked) that fund the outputs and the fee. The builder
   * takes them in order of AP3X-only first and the most AP3X first.
   */
  wallet: readonly Utxo[];
  /** Where the leftover value goes. */
  changeAddress: string;
  /** Key-locked AP3X-only UTxOs for collateral. Default: the wallet. */
  collateral?: readonly Utxo[];
  /**
   * Execution units per redeemer, keyed `"<tag>:<index>"` (for example
   * `"spend:0"`, `"mint:1"`, `"withdraw:0"`), as an evaluator (Ogmios
   * `evaluateTransaction`) reports them for an earlier build. Without a
   * value, a redeemer gets an equal share of the transaction limit, which is
   * always enough but costs a higher fee.
   */
  exUnits?: Readonly<Record<string, ExUnits>>;
  /**
   * The current reward balance of each script stake credential that a
   * builder withdraws from, keyed by the script hash (Module-1 for a
   * consent). The ledger accepts a withdrawal only of the whole balance, so
   * read it from the chain (for example `getDelegation`) just before the build.
   */
  rewardBalances?: Readonly<Record<string, bigint>>;
}

/** One redeemer of a built transaction, in ledger order. */
export interface BuiltRedeemer {
  tag: RedeemerTag;
  index: number;
  /** What the redeemer does, for example `identity Register`. */
  label: string;
  exUnits: ExUnits;
}

/** What every builder returns. */
export interface UnsignedTx {
  /** The Conway transaction: body, witness set with redeemers and scripts but no key witnesses, valid, no metadata. */
  txCborHex: string;
  /** The transaction ID: blake2b-256 of the body. Each key holder signs it. */
  txHash: string;
  /**
   * Every key hash that must sign: the `required_signers` of the body, the
   * payment keys of the spent wallet inputs and of the collateral. Sorted.
   */
  requiredSigners: string[];
  /** The body's `required_signers` field (the `extra_signatories` that the scripts check). Sorted. */
  extraSignatories: string[];
  /** The reference inputs that the transaction reads: records, configuration, delegations, reference scripts. Sorted. */
  referenceInputs: OutputReference[];
  /** The spent inputs. Sorted. */
  inputs: OutputReference[];
  /** The UTxOs that the transaction creates, in output order (for the next transaction). */
  outputs: Utxo[];
  fee: bigint;
  window: ValidityWindow;
  redeemers: BuiltRedeemer[];
  /** The size of the transaction with every key witness. */
  signedSize: number;
}

/** A builder refused its inputs. `reason` is a stable snake_case code; the message says why. */
export function refuse(reason: string, message: string): never {
  throw new TxConstructionError(reason, message);
}

export { TxConstructionError };
