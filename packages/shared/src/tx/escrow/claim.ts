/**
 * tx/escrow/claim.ts — builds a Claim transaction (Open → Claimed).
 *
 * Signed by supplier. Continuing output carries updated datum (state=Claimed),
 * value preserved, validity upper-bound ≤ deliver_by.
 *
 * Off-chain invariants:
 *   1. walletKey.pubKeyHash === datum.supplier_pkh
 *   2. datum.state === "Open"
 *   3. validity upper-bound ≤ datum.deliver_by (chain tip < deliver_by)
 *   4. hi − lo ≤ MAX_RANGE_MS (Part 2 §6.5): hi = min(deliver_by, lo + 1 h)
 *
 * Both layouts (Part 2 §9.6): the escrow datum decides. A 16-field escrow
 * (identity layout) also needs `lookupRecord`: the agent record becomes a
 * reference input, and the builder refuses when a Claim check of §6.1 fails
 * (identityEscrow.ts claimIdentity).
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { IdentityBlueprint } from "../blueprint.js";
import type { RecordLookup } from "../identityRecord.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { MAX_RANGE_MS, mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { readEscrow } from "../internal/layout.js";
import { claimIdentity } from "./identityEscrow.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface ClaimParams {
  chain: ChainProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
  /** Identity layout only: finds the agent record (required for a 16-field escrow). */
  lookupRecord?: RecordLookup;
  /** Identity layout only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
}

export async function buildClaimTx(
  params: ClaimParams,
): Promise<BuildResult> {
  const { chain, supplierKey, escrowRef } = params;

  const escrow = await readEscrow(chain, escrowRef);
  if (escrow.layout === "identity") {
    return claimIdentity({
      chain,
      escrow,
      supplierKey,
      lookupRecord: params.lookupRecord,
      identityBlueprint: params.identityBlueprint,
      beforeSubmit: params.beforeSubmit,
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

  // 2. State must be Open.
  if (datum.state !== "Open") {
    throw new TxConstructionError(
      "wrong state",
      `expected Open for Claim, got ${datum.state}`,
    );
  }

  // 3. Tip must be before deliver_by.
  // On the live backend, the deadline is measured in real POSIX ms (Date.now())
  // because the lucid validity-range will be emitted in real time. On the mock
  // backend, we keep the existing slot*1000 convention.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  if (tipMs >= datum.deliver_by) {
    throw new TxConstructionError(
      "claim after deliver_by",
      `tip ${tipMs} >= deliver_by ${datum.deliver_by}`,
    );
  }

  const newDatum = { ...datum, state: "Claimed" as const };

  // Live path: real Cardano CBOR via lucid-evolution.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForClaim } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForClaim({
      chain: chain as LiveOgmiosProvider,
      supplierKey,
      escrowRef,
      escrowUtxo: utxo,
      newDatum,
      deliverBy: datum.deliver_by,
      tipMs,
      beforeSubmit: params.beforeSubmit,
    });
  }

  const body = {
    type: "claim",
    inputs: [escrowRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: utxo.address,
        lovelace: utxo.lovelace,
        assets: utxo.assets,
        datumHex: encodeEscrowDatum(newDatum),
        scriptRef: null,
      },
    ],
    requiredSigners: [supplierKey.pubKeyHash],
    validityRange: { lowerBoundMs: tipMs, upperBoundMs: Math.min(datum.deliver_by, tipMs + MAX_RANGE_MS) },
    redeemer: "Claim",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);
  await params.beforeSubmit?.({ txCborHex, expectedTxHash });

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
