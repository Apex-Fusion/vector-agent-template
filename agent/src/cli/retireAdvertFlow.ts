/**
 * retireAdvertFlow.ts — pure logic layer for the `tx:retire-advert` CLI.
 *
 * Spends the advert UTxO and returns its bond to the supplier wallet.
 * Validator only checks signer + at-least-one-output-to-supplier (see
 * contracts/marketplace/validators/advert.ak handle_retire).
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import { buildRetireAdvertTx, type WalletKey } from "@marketplace/shared/tx";

export interface RetireAdvertFlowParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  advertRef: OutputReference;
  /** Milliseconds to wait for on-chain confirmation. Default: 120_000. */
  awaitTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RetireAdvertFlowResult {
  /** Hex-encoded transaction hash (64 chars). */
  txHash: string;
  /** Operator-paste string: "<txHash>". */
  formattedRef: string;
}

export async function runRetireAdvert(
  params: RetireAdvertFlowParams,
): Promise<RetireAdvertFlowResult> {
  const { chain, walletKey, advertRef } = params;
  const writeLog =
    params.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const timeoutMs = params.awaitTimeoutMs ?? 120_000;

  writeLog(`retiring advert ${advertRef.txHash}#${advertRef.index}`);

  const built = await buildRetireAdvertTx({ chain, walletKey, advertRef });

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
    formattedRef: built.expectedTxHash,
  };
}
