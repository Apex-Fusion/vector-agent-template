/**
 * tx/escrow/submit.ts — builds a Submit transaction (Claimed → Submitted).
 *
 * Signed by supplier. New datum: state=Submitted, submitted_at=upper_bound,
 * result_receipt_hash=Some(receiptHash). All other fields unchanged.
 * Validity upper-bound ≤ deliver_by.
 *
 * Off-chain invariants:
 *   1. walletKey.pubKeyHash === datum.supplier_pkh
 *   2. datum.state === "Claimed"
 *   3. receiptHash is a 32-byte hex string
 *   4. validity upper-bound ≤ datum.deliver_by
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { decodeEscrowDatum, encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { WalletKey, BuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface SubmitParams {
  chain: ChainProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  receiptHash: string;
}

function isHex32(s: string): boolean {
  return typeof s === "string" && s.length === 64 && /^[0-9a-fA-F]{64}$/.test(s);
}

export async function buildSubmitTx(
  params: SubmitParams,
): Promise<BuildResult> {
  const { chain, supplierKey, escrowRef, receiptHash } = params;

  // 3. Receipt hash must be a 32-byte hex string. Check first since it's
  // independent of chain state.
  if (!isHex32(receiptHash)) {
    throw new TxConstructionError(
      "receipt hash must be 32 bytes",
      `receiptHash length=${receiptHash?.length ?? 0}, expected 64 hex chars`,
    );
  }

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

  // 2. State must be Claimed.
  if (datum.state === "Submitted") {
    throw new TxConstructionError("double submit", "escrow already in Submitted state");
  }
  if (datum.state !== "Claimed") {
    throw new TxConstructionError("wrong state", `expected Claimed, got ${datum.state}`);
  }

  // 4. Tip must be before deliver_by; validity upper-bound used as submit stamp.
  // Live backend uses real POSIX ms; mock backend keeps the slot*1000 convention.
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const tipMs = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  if (tipMs >= datum.deliver_by) {
    throw new TxConstructionError(
      "submit after deliver_by",
      `tip ${tipMs} >= deliver_by ${datum.deliver_by}`,
    );
  }

  // Use tipMs as the canonical validity upper bound = submitted_at stamp.
  const submittedAt = tipMs;

  const newDatum = {
    ...datum,
    state: "Submitted" as const,
    submitted_at: submittedAt,
    result_receipt_hash: receiptHash.toLowerCase(),
  };

  // Live path: real Cardano CBOR via lucid-evolution.
  if (detectCborBackend(chain) === "live") {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForSubmit } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForSubmit({
      chain: chain as LiveOgmiosProvider,
      supplierKey,
      escrowRef,
      escrowUtxo: utxo,
      newDatum,
      deliverBy: datum.deliver_by,
      tipMs,
      receiptHash: receiptHash.toLowerCase(),
    });
  }

  const body = {
    type: "submit",
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
    validityRange: { lowerBoundMs: tipMs, upperBoundMs: submittedAt },
    redeemer: "Submit",
    meta: { receipt_hash: receiptHash.toLowerCase() },
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
