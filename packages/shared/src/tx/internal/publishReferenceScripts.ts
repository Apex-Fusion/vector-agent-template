/**
 * publishReferenceScripts.ts — one-shot tx builder that publishes the escrow
 * and advert validator scripts as CIP-33 reference UTxOs.
 *
 * The two outputs are paid to a caller-supplied address (typically a known
 * burn address such as the all-zero-pkh enterprise address) with the script
 * bytes attached as `scriptRef`. Subsequent script-spending txs reference
 * these UTxOs via env (ESCROW_REF_UTXO, ADVERT_REF_UTXO) and skip inlining
 * the script bytes — saving ~5 KB per script-spending tx.
 *
 * One-shot operational tool. Invoke via supplier/src/cli/publish-reference-scripts.ts.
 */

import type { Script } from "@lucid-evolution/lucid";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "./lucidContext.js";

export interface LivePublishRefScriptsParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  /** Address to publish the two reference-script UTxOs to. Typically a known
   *  burn address (cryptographically unspendable) so refs cannot be spent. */
  burnAddr: string;
  escrowScript: Script;
  advertScript: Script;
  /** Lovelace for the escrow output. Default 30_000_000n (30 AP3X). For tight
   *  budgets pass ~17_000_000n — escrow script is ~3.4 KB → ledger min ~15.7 AP3X. */
  escrowLovelace?: bigint;
  /** Lovelace for the advert output. Default 30_000_000n (30 AP3X). For tight
   *  budgets pass ~7_000_000n — advert script is ~1 KB → ledger min ~5.4 AP3X. */
  advertLovelace?: bigint;
}

export interface PublishRefScriptsBuildResult extends BuildResult {
  /** Output index 0 — escrow script reference. */
  escrowRef: { txHash: string; outputIndex: number };
  /** Output index 1 — advert script reference. */
  advertRef: { txHash: string; outputIndex: number };
  formattedEscrowRef: string;
  formattedAdvertRef: string;
}

const DEFAULT_LOVELACE_PER_OUTPUT = 30_000_000n;

export async function buildLiveTxForPublishReferenceScripts(
  params: LivePublishRefScriptsParams,
): Promise<PublishRefScriptsBuildResult> {
  const { chain, walletKey, burnAddr, escrowScript, advertScript } = params;
  const escrowLovelace = params.escrowLovelace ?? DEFAULT_LOVELACE_PER_OUTPUT;
  const advertLovelace = params.advertLovelace ?? DEFAULT_LOVELACE_PER_OUTPUT;

  const provider = new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
  const { lucid } = await createLucidContext(provider, walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const realWalletUtxos = await lucid.wallet().getUtxos();

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      // Output 0: escrow script reference.
      .pay.ToAddressWithData(
        burnAddr,
        undefined,
        { lovelace: escrowLovelace },
        escrowScript,
      )
      // Output 1: advert script reference.
      .pay.ToAddressWithData(
        burnAddr,
        undefined,
        { lovelace: advertLovelace },
        advertScript,
      )
      .addSignerKey(walletKey.pubKeyHash)
      // Bump floor to 500K — lucid's auto-fee under-estimates this tx by
      // ~5K lovelace on Vector L2 mainnet (observed: needed 372,658, lucid
      // computed 367,197). Publish is a one-shot, so 0.13 AP3X overhead is
      // a fine price for not having to chase the fee model.
      .setMinFee(500_000n);

    const completed = await txBuilder.complete({
      presetWalletInputs: realWalletUtxos,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TxConstructionError(`publish-reference-scripts build failed: ${msg}`);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    escrowRef: { txHash: expectedTxHash, outputIndex: 0 },
    advertRef: { txHash: expectedTxHash, outputIndex: 1 },
    formattedEscrowRef: `${expectedTxHash}#0`,
    formattedAdvertRef: `${expectedTxHash}#1`,
  };
}
