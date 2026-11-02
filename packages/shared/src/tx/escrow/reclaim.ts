/**
 * tx/escrow/reclaim.ts — builds a Reclaim transaction (Open|Claimed → Reclaimed, terminal).
 *
 * Signed by buyer. Buyer receives ≥ payment + buyer_bond + supplier_bond.
 * Validity lower-bound ≥ deliver_by.
 *
 * Off-chain invariants:
 *   1. walletKey.pubKeyHash === datum.buyer_pkh
 *   2. datum.state === "Open" || datum.state === "Claimed"
 *   3. validity lower-bound ≥ datum.deliver_by (chain tip past deliver_by)
 *
 * Both layouts (Part 2 §9.6): the escrow datum decides. For a 16-field
 * escrow with `refund` set, invariant 1 does not apply: any wallet key can
 * submit the Reclaim (it pays the fee and the collateral), no buyer
 * signature is needed, and the whole escrow value goes to refund.address with
 * exactly the refund datum (§6.1; identityEscrow.ts reclaimIdentity).
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { IdentityBlueprint } from "../blueprint.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { LOWER_BOUND_BACKPAD_MS, mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { readEscrow } from "../internal/layout.js";
import { reclaimIdentity } from "./identityEscrow.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface ReclaimParams {
  chain: ChainProvider;
  /** The buyer key; for an identity escrow with `refund` set, any wallet key. */
  buyerKey: WalletKey;
  escrowRef: OutputReference;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
  /** Identity layout only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
}

export async function buildReclaimTx(
  params: ReclaimParams,
): Promise<BuildResult> {
  const { chain, buyerKey, escrowRef } = params;

  const escrow = await readEscrow(chain, escrowRef);
  if (escrow.layout === "identity") {
    return reclaimIdentity({
      chain,
      escrow,
      walletKey: buyerKey,
      identityBlueprint: params.identityBlueprint,
      beforeSubmit: params.beforeSubmit,
    });
  }
  const { utxo, datum } = escrow;

  // 1. Signer must match buyer identity.
  if (buyerKey.pubKeyHash !== datum.buyer_pkh) {
    throw new TxConstructionError(
      "buyer signature mismatch",
      `buyerKey pkh ${buyerKey.pubKeyHash} does not match datum.buyer_pkh ${datum.buyer_pkh}`,
    );
  }

  // 2. State must be Open or Claimed.
  if (datum.state !== "Open" && datum.state !== "Claimed") {
    throw new TxConstructionError(
      "wrong state",
      `expected Open or Claimed for Reclaim, got ${datum.state}`,
    );
  }

  // 3. Tip must be at or past deliver_by.
  // Live backend uses real POSIX ms; mock backend keeps slot*1000.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  if (tipMs < datum.deliver_by) {
    throw new TxConstructionError(
      "reclaim before deliver_by",
      `tip ${tipMs} < deliver_by ${datum.deliver_by}`,
    );
  }

  // Live path: real Cardano CBOR via lucid-evolution.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForReclaim } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForReclaim({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      escrowRef,
      escrowUtxo: utxo,
      datum,
      tipMs,
      beforeSubmit: params.beforeSubmit,
    });
  }

  // Mock path: synthetic testTxBody (preserves existing test behaviour).
  const buyerDue =
    datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace;

  const body = {
    type: "reclaim",
    inputs: [escrowRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: buyerKey.address,
        lovelace: buyerDue,
        assets: {},
        datumHex: null,
        scriptRef: null,
      },
    ],
    requiredSigners: [buyerKey.pubKeyHash],
    // Same range as the live builder: no time before deliver_by, hi − lo ≤ MAX_RANGE_MS (Part 2 §6.5).
    validityRange: { lowerBoundMs: Math.max(datum.deliver_by, tipMs - LOWER_BOUND_BACKPAD_MS), upperBoundMs: tipMs + 60_000 },
    redeemer: "Reclaim",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);
  await params.beforeSubmit?.({ txCborHex, expectedTxHash });

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
