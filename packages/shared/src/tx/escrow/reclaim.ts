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
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { decodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface ReclaimParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  escrowRef: OutputReference;
}

export async function buildReclaimTx(
  params: ReclaimParams,
): Promise<BuildResult> {
  const { chain, buyerKey, escrowRef } = params;

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
    validityRange: { lowerBoundMs: datum.deliver_by, upperBoundMs: tipMs + 60_000 },
    redeemer: "Reclaim",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
