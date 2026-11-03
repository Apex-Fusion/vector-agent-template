/**
 * tx/advert/postAdvert.ts — builds a PostAdvert transaction.
 *
 * Off-chain builder enforces:
 *   1. walletKey.pubKeyHash === advertDatum.supplier_pkh (signature mismatch)
 *   2. advertDatum.status === "Active" (fresh advert must be Active)
 *   3. advertDatum.advertised_at within ±5min of chain tip wallclock
 *      (advertised_at out of validity range)
 *
 * Both layouts (Part 2 §9.6): a datum with `agent_id` (IdentityAdvertDatum)
 * posts the new advert at the new advert script. It also needs `lookupRecord`:
 * the builder refuses unless the advert will be listed (§6.2; the record of
 * agent_id lists supplier_pkh and capability_id and is effectively Active).
 *
 * Returns PostAdvertBuildResult with txCborHex, expectedTxHash, advertOutputRef.
 */

import type { ChainProvider } from "../../chain/ChainProvider.js";
import type { AdvertDatum } from "../../cbor/types.js";
import { encodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { encodeIdentityAdvertDatum, type IdentityAdvertDatum } from "../../cbor/IdentityAdvertDatum.js";
import type { WalletKey, PostAdvertBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { loadBlueprint, loadIdentityBlueprint, type IdentityBlueprint } from "../blueprint.js";
import type { RecordLookup } from "../identityRecord.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { isIdentityAdvertDatum } from "../internal/layout.js";
import { assertAdvertAgentListed } from "./identityAdvert.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

const FIVE_MIN_MS = 5 * 60 * 1000;

export interface PostAdvertParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  /** A datum with agent_id (IdentityAdvertDatum) posts the new advert. */
  advertDatum: AdvertDatum | IdentityAdvertDatum;
  deposit_lovelace: bigint;
  /** Durable journal hook invoked with signed CBOR before broadcast. */
  beforeSubmit?: (built: PostAdvertBuildResult) => Promise<void>;
  /** New advert only: finds the agent record (required). */
  lookupRecord?: RecordLookup;
  /** New advert only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
}

export async function buildPostAdvertTx(
  params: PostAdvertParams,
): Promise<PostAdvertBuildResult> {
  const { chain, walletKey, advertDatum, deposit_lovelace } = params;

  // 1. Signer must match supplier identity.
  if (walletKey.pubKeyHash !== advertDatum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `wallet pkh ${walletKey.pubKeyHash} does not match advert.supplier_pkh ${advertDatum.supplier_pkh}`,
    );
  }

  // 2. Fresh advert must be Active.
  if (advertDatum.status !== "Active") {
    throw new TxConstructionError(
      "fresh advert must be Active",
      `advertDatum.status is ${advertDatum.status}, expected Active`,
    );
  }

  // 3. advertised_at within ±5min of "now". Backend selects the time source:
  //    - live → Date.now() (real POSIX ms; matches the lucid validity range)
  //    - mock → mockSlotToWallclockMs(tipSlot) (slot*1000 convention)
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  if (Math.abs(advertDatum.advertised_at - tipMs) > FIVE_MIN_MS) {
    throw new TxConstructionError(
      "advertised_at out of validity range",
      `advertised_at=${advertDatum.advertised_at} drifts > 5min from tip wallclock=${tipMs}`,
    );
  }

  // 4. New advert: the listing rule must hold now.
  let target: { address: (networkId: 0 | 1) => string; scriptHash: string; datumHex: string };
  if (isIdentityAdvertDatum(advertDatum)) {
    const blueprint = params.identityBlueprint ?? loadIdentityBlueprint();
    await assertAdvertAgentListed(params.lookupRecord, blueprint, advertDatum, tipMs);
    target = {
      address: (networkId) => blueprint.advertScriptAddress(networkId),
      scriptHash: blueprint.advertScriptHash,
      datumHex: encodeIdentityAdvertDatum(advertDatum),
    };
  } else {
    const blueprint = loadBlueprint();
    target = {
      address: (networkId) => blueprint.advertScriptAddress(networkId),
      scriptHash: blueprint.advertScriptHash,
      datumHex: encodeAdvertDatum(advertDatum),
    };
  }

  // 5. Construct tx body.
  // Live path: route to lucid-evolution so the on-chain submission carries
  // valid Conway-era CBOR. Mock path keeps the JSON-in-hex synthetic body.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForAdvert } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForAdvert({
      chain: chain as LiveOgmiosProvider,
      walletKey,
      advertDatum,
      deposit_lovelace,
      beforeSubmit: params.beforeSubmit,
      target: { address: target.address(1), datumHex: target.datumHex },
    });
  }

  const body = {
    type: "post-advert",
    inputs: [],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: target.address(0),
        lovelace: deposit_lovelace,
        assets: {},
        datumHex: target.datumHex,
        scriptRef: null,
      },
    ],
    requiredSigners: [walletKey.pubKeyHash],
    meta: { script_hash: target.scriptHash },
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);
  const built: PostAdvertBuildResult = {
    txCborHex,
    expectedTxHash,
    advertOutputRef: { txHash: expectedTxHash, index: 0 },
  };
  await params.beforeSubmit?.(built);

  // Submit so the mock seeds the new UTxO + spends inputs (none here).
  await chain.submitTx(txCborHex);

  return built;
}
