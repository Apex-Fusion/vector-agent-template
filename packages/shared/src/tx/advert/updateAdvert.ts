/**
 * tx/advert/updateAdvert.ts — builds an UpdateAdvert transaction.
 *
 * Spends an existing advert UTxO and produces a continuing output at the
 * same script address with the updated datum.
 *
 * Off-chain invariants enforced:
 *   1. walletKey.pubKeyHash === oldDatum.supplier_pkh
 *   2. newDatum.supplier_pkh === oldDatum.supplier_pkh (supplier unchanged)
 *   3. newDatum.advertised_at >= oldDatum.advertised_at (no regress)
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { AdvertDatum } from "../../cbor/types.js";
import { encodeAdvertDatum, decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";

export interface UpdateAdvertParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  advertRef: OutputReference;
  newAdvertDatum: AdvertDatum;
  deposit_lovelace: bigint;
}

export async function buildUpdateAdvertTx(
  params: UpdateAdvertParams,
): Promise<BuildResult> {
  const { chain, walletKey, advertRef, newAdvertDatum, deposit_lovelace } = params;

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

  const oldDatum = decodeAdvertDatum(utxo.datumHex);

  // 1. Signer must match the existing supplier identity.
  if (walletKey.pubKeyHash !== oldDatum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `wallet pkh ${walletKey.pubKeyHash} does not match oldDatum.supplier_pkh ${oldDatum.supplier_pkh}`,
    );
  }

  // 2. Supplier pkh must not change.
  if (newAdvertDatum.supplier_pkh !== oldDatum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier pkh changed",
      `newDatum.supplier_pkh ${newAdvertDatum.supplier_pkh} differs from old ${oldDatum.supplier_pkh}`,
    );
  }

  // 3. advertised_at must be monotonically non-decreasing.
  if (newAdvertDatum.advertised_at < oldDatum.advertised_at) {
    throw new TxConstructionError(
      "advertised_at regress",
      `new ${newAdvertDatum.advertised_at} < old ${oldDatum.advertised_at}`,
    );
  }

  const body = {
    type: "update-advert",
    inputs: [advertRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: utxo.address,
        lovelace: deposit_lovelace,
        assets: {},
        datumHex: encodeAdvertDatum(newAdvertDatum),
        scriptRef: null,
      },
    ],
    requiredSigners: [walletKey.pubKeyHash],
    redeemer: "UpdateAdvert",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
