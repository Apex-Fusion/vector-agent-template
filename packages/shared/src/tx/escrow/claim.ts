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
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface ClaimParams {
  chain: ChainProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
}

export async function buildClaimTx(
  params: ClaimParams,
): Promise<BuildResult> {
  const { chain, supplierKey, escrowRef } = params;

  const utxo = await chain.queryUtxo(escrowRef);
  if (utxo === null) {
    throw new TxConstructionError(
      "escrow ref not on chain",
      `no UTxO at ${escrowRef.txHash}#${escrowRef.index}`,
    );
  }
  if (!utxo.datumHex) {
    throw new TxConstructionError(
      "escrow datum missing",
      `UTxO ${escrowRef.txHash}#${escrowRef.index} has no inline datum`,
    );
  }

  const datum = decodeEscrowDatum(utxo.datumHex);

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
  if (detectCborBackend(chain) === "live") {
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
    validityRange: { lowerBoundMs: tipMs, upperBoundMs: datum.deliver_by },
    redeemer: "Claim",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
