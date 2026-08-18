/**
 * postAdvertFlow.ts — pure logic layer for the `tx:post-advert` CLI (M1-F-3).
 *
 * Exports:
 *   runPostAdvert(params) — validate, build, submit, await, return ref.
 *
 * Tests are written against the interface + behaviours declared here; do not
 * change the exported types without updating tests first.
 */

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum } from "@marketplace/shared/cbor";
import {
  buildPostAdvertTx,
  detectCborBackend,
  mockSlotToWallclockMs,
  TxConstructionError,
  type WalletKey,
} from "@marketplace/shared/tx";

export interface PostAdvertFlowParams {
  chain: ChainProvider;
  walletKey: WalletKey;
  advertDatum: AdvertDatum;
  /** Milliseconds to wait for on-chain confirmation. Default: 120_000. */
  awaitTimeoutMs?: number;
  /**
   * Progress logger. Called with human-readable status lines. Must be called
   * at minimum with:
   *   "posting advert"
   *   "submitted tx <hash>"
   *   "awaiting confirmation"
   *   "confirmed"
   * in that order. Defaults to console.log.
   */
  log?: (line: string) => void;
}

export interface PostAdvertFlowResult {
  /** Hex-encoded transaction hash (64 chars). */
  txHash: string;
  /** The advert UTxO reference: { txHash, index: 0 }. */
  advertRef: OutputReference;
  /** Operator-paste string: "<txHash>#0". */
  formattedRef: string;
}

/**
 * runPostAdvert — build and submit a PostAdvert transaction.
 *
 * Validates:
 *   - walletKey.pubKeyHash === advertDatum.supplier_pkh  (TxConstructionError "supplier signature mismatch")
 *   - advertDatum.status === "Active"                    (TxConstructionError "fresh advert must be Active")
 *   - advertDatum.endpoint_url non-empty                 (TxConstructionError "endpoint_url required")
 *   - advertDatum.detail_hash is exactly 64 hex chars    (TxConstructionError "detail_hash must be 32 bytes")
 *
 * On chain.submitTx rejection: re-throws underlying error as-is.
 * On awaitTx timeout: rejects with a timeout error that includes the txHash so
 *   the operator can recover manually.
 *
 * Default awaitTimeoutMs: 120_000.
 * Default log: console.log.
 */
export async function runPostAdvert(
  params: PostAdvertFlowParams,
): Promise<PostAdvertFlowResult> {
  const { chain, walletKey, advertDatum } = params;
  const writeLog =
    params.log ??
    ((line: string) => {
      // eslint-disable-next-line no-console
      console.log(line);
    });
  const timeoutMs = params.awaitTimeoutMs ?? 120_000;

  // Off-chain field-presence validations (additional to buildPostAdvertTx's
  // signer + status + ±5min checks).
  if (!advertDatum.endpoint_url || advertDatum.endpoint_url.length === 0) {
    throw new TxConstructionError(
      "endpoint_url required",
      "AdvertDatum.endpoint_url must be a non-empty string",
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(advertDatum.detail_hash)) {
    throw new TxConstructionError(
      "detail_hash must be 32 bytes",
      "AdvertDatum.detail_hash must be 64 lowercase hex chars (sha256)",
    );
  }

  // Recompute advertised_at (caller's value is intentionally ignored).
  // Construct a NEW datum object so the caller's input is not mutated.
  // Backend selects the time source:
  //   - live → Date.now() (real POSIX ms; aligns with the live tx-builder)
  //   - mock → mockSlotToWallclockMs(tipSlot) (slot*1000 mock convention)
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const advertisedAt = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const datumToSubmit: AdvertDatum = {
    ...advertDatum,
    advertised_at: advertisedAt,
  };

  writeLog("posting advert");

  // The supplier-bond convention: deposit equals supplier_bond_lovelace.
  // Mirrors the validator-level bond-locking expectation.
  const built = await buildPostAdvertTx({
    chain,
    walletKey,
    advertDatum: datumToSubmit,
    deposit_lovelace: datumToSubmit.supplier_bond_lovelace,
  });

  writeLog(`submitted tx ${built.expectedTxHash}`);
  writeLog("awaiting confirmation");

  try {
    await chain.awaitTx(built.expectedTxHash, timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    // Surface the txHash explicitly so operators can verify on-chain manually.
    const wrapped = new Error(
      reason.includes(built.expectedTxHash)
        ? reason
        : `awaitTx failed for txHash ${built.expectedTxHash}: ${reason}`,
    );
    throw wrapped;
  }

  writeLog("confirmed");

  return {
    txHash: built.expectedTxHash,
    advertRef: built.advertOutputRef,
    formattedRef: `${built.advertOutputRef.txHash}#${built.advertOutputRef.index}`,
  };
}
