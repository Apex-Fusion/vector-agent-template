/**
 * tx/advert/retireAdvert.ts — builds a RetireAdvert transaction.
 *
 * Spends the advert UTxO. At least one output pays back to the supplier
 * wallet address. Signed by supplier_pkh.
 *
 * Off-chain invariants enforced:
 *   1. walletKey.pubKeyHash === datum.supplier_pkh
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { detectCborBackend } from "../internal/cborBackend.js";

export interface RetireAdvertParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  advertRef: OutputReference;
}

export async function buildRetireAdvertTx(
  params: RetireAdvertParams,
): Promise<BuildResult> {
  const { chain, walletKey, advertRef } = params;

  const utxo = await chain.queryUtxo(advertRef);
  if (utxo === null) {
    throw new TxConstructionError(
      "advert ref not on chain",
      `no UTxO at ${advertRef.txHash}#${advertRef.index}`,
    );
  }
  if (!utxo.datumHex) {
    throw new TxConstructionError(
      "advert datum missing",
      `UTxO ${advertRef.txHash}#${advertRef.index} has no inline datum`,
    );
  }

  const datum = decodeAdvertDatum(utxo.datumHex);

  // 1. Signer must match the supplier identity.
  if (walletKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `wallet pkh ${walletKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }

  // 2. Live path: build a real Plutus V3 spend via lucid-evolution.
  //    Mock path falls through to the synthetic JSON-in-hex body below.
  if (detectCborBackend(chain) === "live") {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForRetireAdvert } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForRetireAdvert({
      chain: chain as LiveOgmiosProvider,
      walletKey,
      advertRef,
      advertUtxo: utxo,
      datum,
    });
  }

  const body = {
    type: "retire-advert",
    inputs: [advertRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: walletKey.address,
        lovelace: utxo.lovelace,
        assets: {},
        datumHex: null,
        scriptRef: null,
      },
    ],
    requiredSigners: [walletKey.pubKeyHash],
    redeemer: "RetireAdvert",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
