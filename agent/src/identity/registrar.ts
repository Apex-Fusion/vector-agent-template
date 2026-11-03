/**
 * supplier/src/identity/registrar.ts — the record registrar over Ogmios: the
 * identity-family Register builder of the shared package (buildRegister,
 * Part 2 §3.4) with the chain's protocol parameters and the wallet's UTxOs,
 * and its witness helpers (signTransaction, transactionId).
 *
 * The protocol parameters, including the Plutus V3 cost model, come from the
 * chain on every build (a wrong cost model gives a wrong script data hash).
 * The builder sizes the record deposit as max(10 AP3X, ledger minimum). The
 * identity script comes from its reference UTxO (IDENTITY_REF_UTXO). A
 * supplier record has no Module-1 party (supplierRecord refuses a Script
 * signer), so the Register reads no configuration record and withdraws
 * nothing.
 */

import {
  buildRegister, signTransaction, transactionId, VECTOR_MAINNET_SLOT_CONFIG, type ExUnits, type ProtocolParameters,
  type SlotConfig, type TxContext,
} from "@marketplace/shared";
import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import type { RecordRegistrar, RegisterRecordArgs, RegisterRecordTx } from "./register.js";

/** Headroom on the evaluated execution units of the Register mint: the final body differs by its fee only. */
const EX_UNITS_MARGIN_PERCENT = 110n;

export interface ChainRegistrarOptions {
  chain: ChainProvider;
  networkId: 0 | 1;
  /** The identity script hash and policy ID (IDENTITY_POLICY_ID). */
  identityHash: string;
  /** The reference UTxO of the identity script (IDENTITY_REF_UTXO). */
  identityRef: OutputReference;
  /** The chain's current protocol parameters. */
  protocolParameters: () => Promise<ProtocolParameters>;
  slotConfig: SlotConfig;
}

/** The Vector slot clock: mainnet from the shared constant, testnet from VECTOR_ZERO_TIME_MS. */
export function vectorSlotConfig(networkId: 0 | 1, zeroTimeMs: string | undefined): SlotConfig {
  if (networkId === 1) return VECTOR_MAINNET_SLOT_CONFIG;
  if (zeroTimeMs === undefined || !/^[1-9]\d*$/.test(zeroTimeMs) || Number(zeroTimeMs) % 1000 !== 0) {
    throw new Error("VECTOR_ZERO_TIME_MS (the testnet system start, whole seconds in ms) is required on NETWORK_ID=0");
  }
  return { zeroTimeMs: Number(zeroTimeMs), zeroSlot: 0, slotLengthMs: 1000 };
}

/** The wallet output that the Register spends as its seed: AP3X only, the most AP3X. */
function seedOf(wallet: readonly Utxo[]): Utxo {
  const candidates = wallet.filter((utxo) => Object.keys(utxo.assets).length === 0 && utxo.datumHex === null && utxo.scriptRef === null);
  const seed = candidates.sort((a, b) => (a.lovelace === b.lovelace ? 0 : a.lovelace > b.lovelace ? -1 : 1))[0];
  if (seed === undefined) throw new Error("the supplier wallet has no AP3X-only output to spend as the Register seed");
  return seed;
}

/** The record registrar over the chain. */
export function chainRegistrar(options: ChainRegistrarOptions): RecordRegistrar {
  const { chain, networkId, identityHash, identityRef } = options;
  return {
    async build(args: RegisterRecordArgs): Promise<RegisterRecordTx> {
      const [protocol, wallet, identityScript] = await Promise.all([
        options.protocolParameters(), chain.queryUtxosByAddress(args.wallet.address), chain.queryUtxo(identityRef),
      ]);
      if (identityScript === null) {
        throw new Error(`the identity reference script ${identityRef.txHash}#${identityRef.index} is not on chain`);
      }
      const context: TxContext = { networkId, slotConfig: options.slotConfig, protocol, wallet, changeAddress: args.wallet.address };
      const scripts = { identity: { hash: identityHash, referenceUtxo: identityScript }, configPolicy: "", configHolder: "" };
      const register = { seed: seedOf(wallet), window: args.window, controller: args.controller, keys: args.keys,
        parties: args.parties, profile: args.profile };
      // Without evaluated units each redeemer gets an equal share of the limit; evaluate once and build again.
      let built = buildRegister(context, scripts, register);
      const evaluation = await chain.evaluateTx(built.txCborHex);
      if (!evaluation.ok) throw new Error(`the identity script refuses the Register transaction: ${evaluation.error ?? "no reason"}`);
      const [redeemer] = built.redeemers;
      if (evaluation.cost !== undefined && built.redeemers.length === 1 && redeemer !== undefined) {
        const units: ExUnits = {
          mem: (BigInt(evaluation.cost.memory) * EX_UNITS_MARGIN_PERCENT + 99n) / 100n,
          steps: (BigInt(evaluation.cost.steps) * EX_UNITS_MARGIN_PERCENT + 99n) / 100n,
        };
        built = buildRegister({ ...context, exUnits: { [`${redeemer.tag}:${redeemer.index}`]: units } }, scripts, register);
      }
      return { txCborHex: built.txCborHex, txHash: built.txHash, agentId: built.id, requiredSigners: built.requiredSigners };
    },
    sign: signTransaction,
    txId: transactionId,
  };
}

interface OgmiosRatioPrices {
  memory?: unknown;
  cpu?: unknown;
}

function ratio(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d+\/[1-9]\d*$/.test(value)) throw new Error(`Ogmios protocol parameter ${name} is not a ratio`);
  const [numerator, denominator] = value.split("/").map(Number);
  return numerator! / denominator!;
}

function integer(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Ogmios protocol parameter ${name} is not a non-negative integer`);
  }
  return value;
}

/**
 * The protocol parameters of the identity builders from Ogmios v6
 * (`queryLedgerState/protocolParameters`; field names of the Ogmios v6
 * schema, https://ogmios.dev/api/v6/ and
 * https://github.com/CardanoSolutions/ogmios/blob/master/docs/static/cardano.json).
 * A missing or malformed value is an error, never a default.
 */
export async function ogmiosProtocolParameters(
  ogmiosUrl: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProtocolParameters> {
  const response = await fetchImpl(ogmiosUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "queryLedgerState/protocolParameters", id: "register-record" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Ogmios HTTP ${response.status} for the protocol parameters`);
  const body = await response.json() as { result?: Record<string, unknown>; error?: { message?: string } };
  if (body.result === undefined) throw new Error(`Ogmios protocol parameters: ${body.error?.message ?? "no result"}`);
  const raw = body.result;
  const prices = (raw.scriptExecutionPrices ?? {}) as OgmiosRatioPrices;
  const units = (raw.maxExecutionUnitsPerTransaction ?? {}) as { memory?: unknown; cpu?: unknown };
  const minFeeConstant = (raw.minFeeConstant as { ada?: { lovelace?: unknown } } | undefined)?.ada?.lovelace;
  const referenceScripts = (raw.minFeeReferenceScripts as { base?: unknown } | undefined)?.base;
  const costModels = raw.plutusCostModels as Record<string, unknown> | undefined;
  const plutusV3 = costModels?.["plutus:v3"];
  if (!Array.isArray(plutusV3) || plutusV3.length === 0 || plutusV3.some((cost) => !Number.isSafeInteger(cost))) {
    throw new Error("Ogmios protocol parameters have no Plutus V3 cost model");
  }
  if (typeof referenceScripts !== "number" || !Number.isFinite(referenceScripts) || referenceScripts < 0) {
    throw new Error("Ogmios protocol parameter minFeeReferenceScripts.base is not a non-negative number");
  }
  return {
    minFeeA: integer(raw.minFeeCoefficient, "minFeeCoefficient"),
    minFeeB: integer(minFeeConstant, "minFeeConstant"),
    priceMem: ratio(prices.memory, "scriptExecutionPrices.memory"),
    priceStep: ratio(prices.cpu, "scriptExecutionPrices.cpu"),
    coinsPerUtxoByte: BigInt(integer(raw.minUtxoDepositCoefficient, "minUtxoDepositCoefficient")),
    collateralPercentage: integer(raw.collateralPercentage, "collateralPercentage"),
    maxCollateralInputs: integer(raw.maxCollateralInputs, "maxCollateralInputs"),
    maxTxSize: integer((raw.maxTransactionSize as { bytes?: unknown } | undefined)?.bytes, "maxTransactionSize"),
    maxTxExMem: BigInt(integer(units.memory, "maxExecutionUnitsPerTransaction.memory")),
    maxTxExSteps: BigInt(integer(units.cpu, "maxExecutionUnitsPerTransaction.cpu")),
    minFeeRefScriptCostPerByte: referenceScripts,
    costModels: { PlutusV3: plutusV3 as number[] },
  };
}
