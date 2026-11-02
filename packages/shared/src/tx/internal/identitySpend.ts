/**
 * tx/internal/identitySpend.ts — one script spend of the identity layout
 * (new escrow or new advert), planned by a builder and written for the
 * chain's backend:
 * - live: lucid-evolution (liveIdentityCbor.ts), mainnet addresses;
 * - mock: the synthetic testTxBody, testnet addresses, as the legacy builders.
 *
 * Every plan spends exactly one script output and runs no other script
 * (Part 2 §6.5 "All escrow builders").
 */

import type { ChainProvider, OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { BuildResult, WalletKey } from "../types.js";
import { detectCborBackend } from "./cborBackend.js";
import { encodeTxBody, sha256Hex } from "./testTxBody.js";
import type { ValidityWindow } from "./window.js";

/** An address on the given network (0 testnet, 1 mainnet). */
export type NetworkAddress = (networkId: 0 | 1) => string;

export interface PlannedOutput {
  address: NetworkAddress;
  lovelace: bigint;
  assets?: Record<string, bigint>;
  /** Inline datum as CBOR hex. */
  datumHex?: string | null;
  /** A continuing output that the script compares by value (Claim, Submit). */
  exactValue?: boolean;
}

export interface SpendPlan {
  /** Synthetic body type and error label, for example "claim". */
  action: string;
  redeemer: { name: string; hex: string };
  walletKey: WalletKey;
  input: Utxo;
  script: {
    compiledCode: string;
    hash: string;
    address: NetworkAddress;
    refEnvKey: "IDENTITY_ESCROW_REF_UTXO" | "IDENTITY_ADVERT_REF_UTXO";
  };
  referenceInputs: Utxo[];
  outputs: PlannedOutput[];
  requiredSigners: string[];
  window: ValidityWindow;
  /** Keep the dedicated collateral UTxO out of the inputs (buyer-side spends). */
  reserveCollateral: boolean;
  excludeInputs?: readonly OutputReference[];
  beforeSubmit?: (built: BuildResult) => Promise<void>;
}

/** Builds, signs and submits the planned spend. */
export async function submitSpend(chain: ChainProvider, plan: SpendPlan): Promise<BuildResult> {
  if (detectCborBackend(chain) === "live") {
    // Same dynamic-import guard as the legacy builders: keeps lucid and the
    // CML WASM out of the buyer's browser bundle.
    const livePath = "./liveIdentityCbor.js";
    const { buildLiveScriptSpend } = await import(/* @vite-ignore */ livePath);
    return buildLiveScriptSpend({
      chain: chain as LiveOgmiosProvider,
      walletKey: plan.walletKey,
      input: plan.input,
      script: { ...plan.script, address: plan.script.address(1) },
      redeemerHex: plan.redeemer.hex,
      referenceInputs: plan.referenceInputs,
      outputs: plan.outputs.map((output) => ({
        address: output.address(1),
        lovelace: output.lovelace,
        assets: output.assets ?? {},
        datumHex: output.datumHex ?? null,
        exactValue: output.exactValue ?? false,
      })),
      requiredSigners: plan.requiredSigners,
      window: plan.window,
      reserveCollateral: plan.reserveCollateral,
      excludeInputs: plan.excludeInputs,
      beforeSubmit: plan.beforeSubmit,
      action: plan.action,
    });
  }

  const body = {
    type: plan.action,
    inputs: [plan.input.ref],
    referenceInputs: plan.referenceInputs.map((utxo) => utxo.ref),
    outputs: plan.outputs.map((output, index) => ({
      ref: { txHash: "$self", index },
      address: output.address(0),
      lovelace: output.lovelace,
      assets: output.assets ?? {},
      datumHex: output.datumHex ?? null,
      scriptRef: null,
    })),
    requiredSigners: plan.requiredSigners,
    validityRange: { lowerBoundMs: plan.window.lo, upperBoundMs: plan.window.hi },
    redeemer: plan.redeemer.name,
    meta: { script_hash: plan.script.hash, redeemer_hex: plan.redeemer.hex },
  };
  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);
  await plan.beforeSubmit?.({ txCborHex, expectedTxHash });
  await chain.submitTx(txCborHex);
  return { txCborHex, expectedTxHash };
}
