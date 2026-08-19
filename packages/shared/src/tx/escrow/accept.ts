/**
 * tx/escrow/accept.ts — builds an Accept transaction (Submitted → Accepted, terminal).
 *
 * Signed by buyer. Distributes:
 *   - supplier receives ≥ payment_lovelace + supplier_bond_lovelace
 *   - buyer    receives ≥ buyer_bond_lovelace
 * Validity upper-bound ≤ submitted_at + ACCEPT_WINDOW (600_000 ms).
 *
 * Off-chain invariants:
 *   1. walletKey.pubKeyHash === datum.buyer_pkh
 *   2. datum.state === "Submitted"
 *   3. validity upper-bound ≤ datum.submitted_at + ACCEPT_WINDOW
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { decodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { ACCEPT_WINDOW_MS, mockSlotToWallclockMs } from "../internal/constants.js";
import { pkhToEnterpriseAddress } from "../internal/pkhAddress.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface AcceptParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  escrowRef: OutputReference;
}

export { ACCEPT_WINDOW_MS };

export async function buildAcceptTx(
  params: AcceptParams,
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

  // 2. State must be Submitted.
  if (datum.state !== "Submitted") {
    throw new TxConstructionError("wrong state", `expected Submitted for Accept, got ${datum.state}`);
  }
  if (datum.submitted_at === null) {
    throw new TxConstructionError(
      "submitted_at missing",
      "Submitted-state escrow must carry a submitted_at timestamp",
    );
  }

  // 3. Tip must be within accept window.
  // Live backend uses real POSIX ms; mock backend keeps slot*1000.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const windowEnd = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (tipMs > windowEnd) {
    throw new TxConstructionError(
      "accept window expired",
      `tip ${tipMs} > submitted_at + ACCEPT_WINDOW = ${windowEnd}`,
    );
  }

  // Distribution: supplier gets payment + supplier_bond; buyer gets buyer_bond.
  const supplierDue = datum.payment_lovelace + datum.supplier_bond_lovelace;
  const buyerDue = datum.buyer_bond_lovelace;

  const supplierAddress = pkhToEnterpriseAddress(datum.supplier_pkh, 0);
  const buyerAddress = buyerKey.address;

  // Live path: real Cardano CBOR via lucid-evolution.
  if (detectCborBackend(chain) === "live") {
    // liveCbor pulls in lucid + CML wasm; browser bundles never enter this
    // branch (browser uses ReadOnlyOgmiosProvider). We hide the import path
    // behind a runtime variable + @vite-ignore so Rollup's static analyzer
    // doesn't drag the wasm into the SPA bundle. The Node runtime resolves
    // the path normally; the browser bundle just emits a runtime import that
    // never fires because the conditional guarding it is false in-browser.
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForAccept } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForAccept({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      escrowRef,
      escrowUtxo: utxo,
      datum,
      tipMs,
      windowEnd,
    });
  }

  const body = {
    type: "accept",
    inputs: [escrowRef],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: supplierAddress,
        lovelace: supplierDue,
        assets: {},
        datumHex: null,
        scriptRef: null,
      },
      {
        ref: { txHash: "$self", index: 1 },
        address: buyerAddress,
        lovelace: buyerDue,
        assets: {},
        datumHex: null,
        scriptRef: null,
      },
    ],
    requiredSigners: [buyerKey.pubKeyHash],
    validityRange: { lowerBoundMs: tipMs, upperBoundMs: windowEnd },
    redeemer: "Accept",
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}

