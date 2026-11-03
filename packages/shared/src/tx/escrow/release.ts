/**
 * tx/escrow/release.ts — builds a Release transaction (Submitted → Released, terminal).
 *
 * Signed by supplier. Supplier receives ≥ payment + supplier_bond + buyer_bond.
 * Validity lower-bound ≥ submitted_at + ACCEPT_WINDOW (600_000 ms).
 *
 * Off-chain invariants:
 *   1. walletKey.pubKeyHash === datum.supplier_pkh
 *   2. datum.state === "Submitted"
 *   3. datum.submitted_at is non-null
 *   4. validity lower-bound ≥ datum.submitted_at + ACCEPT_WINDOW
 *
 * Both layouts (Part 2 §9.6): the escrow datum decides; a 16-field escrow
 * goes to identityEscrow.ts releaseIdentity (same rules, the new script).
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { IdentityBlueprint } from "../blueprint.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { ACCEPT_WINDOW_MS, LOWER_BOUND_BACKPAD_MS, mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { readEscrow } from "../internal/layout.js";
import { releaseIdentity } from "./identityEscrow.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface ReleaseParams {
  chain: ChainProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  /** Identity layout only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
}

export async function buildReleaseTx(
  params: ReleaseParams,
): Promise<BuildResult> {
  const { chain, supplierKey, escrowRef } = params;

  const escrow = await readEscrow(chain, escrowRef);
  if (escrow.layout === "identity") {
    return releaseIdentity({
      chain,
      escrow,
      supplierKey,
      identityBlueprint: params.identityBlueprint,
    });
  }
  const { utxo, datum } = escrow;

  // 1. Signer must match supplier identity.
  if (supplierKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `supplierKey pkh ${supplierKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }

  // 2. State must be Submitted.
  if (datum.state !== "Submitted") {
    throw new TxConstructionError("wrong state", `expected Submitted for Release, got ${datum.state}`);
  }
  if (datum.submitted_at === null) {
    throw new TxConstructionError(
      "submitted_at missing",
      "Submitted-state escrow must carry a submitted_at timestamp",
    );
  }

  // 4. Tip must be at or past submitted_at + ACCEPT_WINDOW.
  // Live backend uses real POSIX ms; mock backend keeps slot*1000.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const threshold = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (tipMs < threshold) {
    throw new TxConstructionError(
      "release before accept window",
      `tip ${tipMs} < submitted_at + ACCEPT_WINDOW = ${threshold}`,
    );
  }

  // Live path: real Cardano CBOR via lucid-evolution.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForRelease } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForRelease({
      chain: chain as LiveOgmiosProvider,
      supplierKey,
      escrowRef,
      escrowUtxo: utxo,
      datum,
      tipMs,
    });
  }

  // Mock path: synthetic testTxBody (preserves existing test behaviour).
  const supplierDue =
    datum.payment_lovelace + datum.supplier_bond_lovelace + datum.buyer_bond_lovelace;

  const body = {
    type: "release",
    inputs: [escrowRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: supplierKey.address,
        lovelace: supplierDue,
        assets: {},
        datumHex: null,
        scriptRef: null,
      },
    ],
    requiredSigners: [supplierKey.pubKeyHash],
    // Same range as the live builder: no time before the threshold, hi − lo ≤ MAX_RANGE_MS (Part 2 §6.5).
    validityRange: { lowerBoundMs: Math.max(threshold, tipMs - LOWER_BOUND_BACKPAD_MS), upperBoundMs: tipMs + 60_000 },
    redeemer: "Release",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
