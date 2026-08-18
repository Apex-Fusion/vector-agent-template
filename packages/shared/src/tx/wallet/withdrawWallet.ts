/**
 * withdrawWallet.ts — custodial-exit tx builder (wallet → external address).
 *
 * Mirrors consolidateWallet.ts but pays a chosen amount to an arbitrary bech32
 * address (lucid returns the change to the wallet). This is the withdrawal path
 * for the gateway's custodial wallets: a user can move their unspent AP3X back
 * out. No script, no datum, no native assets.
 *
 * `amountLovelace` omitted ⇒ withdraw all available minus a fee reserve.
 * Live-only (needs a real Ogmios endpoint).
 */

import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "../internal/lucidContext.js";
import { DEFAULT_FEE_RESERVE } from "./planConsolidate.js";

export interface WithdrawWalletParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  /** Destination bech32 address. */
  toAddress: string;
  /** Lovelace to send. Omit to withdraw all available minus the fee reserve. */
  amountLovelace?: bigint;
}

export interface WithdrawWalletBuildResult extends BuildResult {
  amountLovelace: bigint;
  toAddress: string;
}

export async function buildWithdrawTx(
  params: WithdrawWalletParams,
): Promise<WithdrawWalletBuildResult> {
  const { chain, walletKey, toAddress } = params;

  const provider = new OgmiosLucidProvider({ ogmiosUrl: chain.url, fetch: chain.fetchImpl });
  const { lucid } = await createLucidContext(
    provider,
    walletKey,
    { networkId: 1, systemStartUnix: 0, slotLengthMs: 1000 },
    { usePresetProtocolParameters: true },
  );

  const realWalletUtxos = await lucid.wallet().getUtxos();
  const total = realWalletUtxos.reduce((sum, u) => sum + (u.assets.lovelace ?? 0n), 0n);
  const spendable = total - DEFAULT_FEE_RESERVE;

  const amount = params.amountLovelace ?? spendable;
  if (amount <= 0n) {
    throw new TxConstructionError("withdraw_amount_invalid", "nothing to withdraw");
  }
  if (amount > spendable) {
    throw new TxConstructionError(
      "withdraw_insufficient",
      `requested ${amount} exceeds withdrawable ${spendable} (total ${total} minus fee reserve)`,
    );
  }

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .pay.ToAddress(toAddress, { lovelace: amount })
      .addSignerKey(walletKey.pubKeyHash)
      .setMinFee(500_000n);
    const completed = await txBuilder.complete({ presetWalletInputs: realWalletUtxos, localUPLCEval: false });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TxConstructionError("withdraw_build_failed", msg);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash, amountLovelace: amount, toAddress };
}
