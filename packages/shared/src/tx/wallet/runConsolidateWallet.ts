/**
 * runConsolidateWallet.ts — orchestration layer for the consolidate-wallet
 * CLIs (supplier + buyer). Builds + submits the consolidate tx, awaits
 * on-chain confirmation, returns the resulting refs.
 *
 * Live-only (the consolidate builder is live-only).
 */

import type { ChainProvider } from "../../chain/ChainProvider.js";
import { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { TxConstructionError, type WalletKey } from "../types.js";
import {
  buildConsolidateWalletTx,
  type ConsolidateWalletBuildResult,
} from "./consolidateWallet.js";
import type { ConsolidateReason } from "./planConsolidate.js";

export interface ConsolidateWalletFlowParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  collateralLovelace: bigint;
  awaitTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ConsolidateWalletFlowResult {
  /** Null when `reason === "already-healthy"` (no tx submitted). */
  txHash: string | null;
  collateralRef: string | null;
  workingRef: string | null;
  reason: ConsolidateReason;
  inputCount: number;
  totalLovelaceIn: bigint;
  collateralOutputLovelace: bigint;
  workingOutputLovelace: bigint;
}

export async function runConsolidateWallet(
  params: ConsolidateWalletFlowParams,
): Promise<ConsolidateWalletFlowResult> {
  const { chain, walletKey, collateralLovelace } = params;
  const writeLog =
    params.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const timeoutMs = params.awaitTimeoutMs ?? 120_000;

  if (!(chain instanceof LiveOgmiosProvider)) {
    throw new TxConstructionError(
      "consolidate_wallet_requires_live_chain",
      "consolidate-wallet does not support mock mode — needs a real Ogmios endpoint",
    );
  }

  writeLog(`consolidating wallet ${walletKey.address}`);
  writeLog(`target collateral output: ${collateralLovelace} lovelace`);

  const built: ConsolidateWalletBuildResult = await buildConsolidateWalletTx({
    chain,
    walletKey,
    collateralLovelace,
  });

  writeLog(
    `plan: ${built.reason} — ${built.inputCount} input(s), ` +
      `total ${built.totalLovelaceIn} lovelace → ` +
      `collateral ${built.collateralOutputLovelace} + working ${built.workingOutputLovelace}`,
  );

  if (built.alreadyHealthy) {
    writeLog("wallet already healthy — no tx submitted");
    return {
      txHash: null,
      collateralRef: null,
      workingRef: null,
      reason: built.reason,
      inputCount: built.inputCount,
      totalLovelaceIn: built.totalLovelaceIn,
      collateralOutputLovelace: built.collateralOutputLovelace,
      workingOutputLovelace: built.workingOutputLovelace,
    };
  }

  writeLog(`submitted tx ${built.expectedTxHash}`);
  writeLog("awaiting confirmation");

  try {
    await chain.awaitTx(built.expectedTxHash, timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      reason.includes(built.expectedTxHash)
        ? reason
        : `awaitTx failed for txHash ${built.expectedTxHash}: ${reason}`,
    );
  }

  writeLog("confirmed");

  return {
    txHash: built.expectedTxHash,
    collateralRef: `${built.expectedTxHash}#0`,
    workingRef: `${built.expectedTxHash}#1`,
    reason: built.reason,
    inputCount: built.inputCount,
    totalLovelaceIn: built.totalLovelaceIn,
    collateralOutputLovelace: built.collateralOutputLovelace,
    workingOutputLovelace: built.workingOutputLovelace,
  };
}
