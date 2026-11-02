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
 *
 * Both layouts (Part 2 §9.6): the advert datum on chain decides, and the new
 * datum must have the same layout. A new advert (14 fields) also keeps
 * agent_id (§6.2), passes the listing rule after the update (`lookupRecord`)
 * and has a live builder (identityAdvert.ts). The legacy layout keeps its
 * synthetic testTxBody path only.
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { AdvertDatum } from "../../cbor/types.js";
import { encodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import type { IdentityAdvertDatum } from "../../cbor/IdentityAdvertDatum.js";
import type { IdentityBlueprint } from "../blueprint.js";
import type { RecordLookup } from "../identityRecord.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { isIdentityAdvertDatum, readAdvert } from "../internal/layout.js";
import { updateIdentityAdvert } from "./identityAdvert.js";

export interface UpdateAdvertParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  advertRef: OutputReference;
  /** Same layout as the advert on chain: with agent_id for a new advert. */
  newAdvertDatum: AdvertDatum | IdentityAdvertDatum;
  deposit_lovelace: bigint;
  /** New advert only: finds the agent record (required). */
  lookupRecord?: RecordLookup;
  /** New advert only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
  /** New advert only: runs after signing and before broadcast. */
  beforeSubmit?: (built: BuildResult) => Promise<void>;
}

export async function buildUpdateAdvertTx(
  params: UpdateAdvertParams,
): Promise<BuildResult> {
  const { chain, walletKey, advertRef, newAdvertDatum, deposit_lovelace } = params;

  const advert = await readAdvert(chain, advertRef);
  if (advert.layout === "identity") {
    if (!isIdentityAdvertDatum(newAdvertDatum)) {
      throw new TxConstructionError("advert layout mismatch", "the advert on chain has agent_id; the new datum has none");
    }
    return updateIdentityAdvert({
      chain,
      walletKey,
      advert,
      newAdvertDatum,
      deposit_lovelace,
      lookupRecord: params.lookupRecord,
      identityBlueprint: params.identityBlueprint,
      beforeSubmit: params.beforeSubmit,
    });
  }
  if (isIdentityAdvertDatum(newAdvertDatum)) {
    throw new TxConstructionError(
      "advert layout mismatch",
      "a legacy advert cannot take agent_id; retire it and post a new advert",
    );
  }
  const { utxo, datum: oldDatum } = advert;

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
