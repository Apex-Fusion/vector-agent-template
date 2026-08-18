/**
 * tx/escrow/postEscrow.ts — builds a PostEscrow transaction.
 *
 * Queries the advert UTxO at advertRef, verifies it exists and has status
 * Active, then constructs an EscrowDatum and locks payment + bonds at the
 * escrow script.
 *
 * Off-chain invariants enforced:
 *   1. advert UTxO exists at advertRef — TxConstructionError("advert ref not on chain")
 *   2. advert datum.status === "Active" — TxConstructionError("advert is retired")
 *   3. payment_lovelace === advert.price_lovelace — TxConstructionError("payment must equal advertised price")
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh — TxConstructionError("buyer cannot be supplier")
 *   5. prompt is non-empty — TxConstructionError("prompt required")
 *
 * EscrowDatum derivation:
 *   - prompt_hash = sha256(canonical(messages)) per ARCHITECTURE.md §4.2.
 *     The full OpenAI-style messages array is hashed (not just the user's
 *     content) so that supplier-side validation in M1-C can recompute the
 *     same hash from the incoming ChatCompletionRequest body and detect any
 *     system-prompt or role tampering.
 *   - request_spec_hash = sha256(canonical({capability_id, max_output_tokens, model}))
 *     using JCS-sorted keys.
 *   - posted_at = chain tip wallclock (mock convention: slot * 1000).
 *   - deliver_by = posted_at + advert.max_processing_ms + 30_000 (network_buffer).
 *   - locked value = price + buyer_bond + supplier_bond.
 */

// Namespace import — see blueprint.ts header.
import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { EscrowDatum } from "../../cbor/types.js";
import { decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { ChatMessage, WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { loadBlueprint } from "../blueprint.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs, NETWORK_BUFFER_MS } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { escrowLockFloor } from "../internal/minAdaFloor.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface PostEscrowParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  messages: ChatMessage[];
  payment_lovelace: bigint;
}

function sha256Utf8Hex(s: string): string {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export async function buildPostEscrowTx(
  params: PostEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, advertRef, messages, payment_lovelace } = params;

  // 5. Messages must be a non-empty array with valid shape.
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TxConstructionError("messages required", "messages must be a non-empty array of ChatMessage");
  }
  for (const m of messages) {
    if (!m || typeof m.content !== "string" || m.content.length === 0) {
      throw new TxConstructionError("messages required", "each message must have a non-empty string content");
    }
  }

  // 1. Advert UTxO must exist.
  const advertUtxo = await chain.queryUtxo(advertRef);
  if (advertUtxo === null) {
    throw new TxConstructionError(
      "advert ref not on chain",
      `no UTxO at ${advertRef.txHash}#${advertRef.index}`,
    );
  }
  if (!advertUtxo.datumHex) {
    throw new TxConstructionError(
      "advert datum missing",
      `UTxO ${advertRef.txHash}#${advertRef.index} has no inline datum`,
    );
  }

  const advertDatum = decodeAdvertDatum(advertUtxo.datumHex);

  // 2. Advert must be Active.
  if (advertDatum.status !== "Active") {
    throw new TxConstructionError(
      "advert is retired",
      `advert.status is ${advertDatum.status}, expected Active`,
    );
  }

  // 3. Payment must equal advertised price.
  if (payment_lovelace !== advertDatum.price_lovelace) {
    throw new TxConstructionError(
      "payment must equal advertised price",
      `payment ${payment_lovelace} != advert.price ${advertDatum.price_lovelace}`,
    );
  }

  // 4. Buyer cannot be supplier.
  if (buyerKey.pubKeyHash === advertDatum.supplier_pkh) {
    throw new TxConstructionError(
      "buyer cannot be supplier",
      `buyerKey pkh ${buyerKey.pubKeyHash} equals advert.supplier_pkh`,
    );
  }

  // Derive escrow datum fields.
  // Time source depends on backend:
  //   - live  → Date.now() (real POSIX ms; lucid emits real validity ranges)
  //   - mock  → mockSlotToWallclockMs(tipSlot) (synthetic slot * 1000 convention)
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const postedAt = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const deliverBy = postedAt + advertDatum.max_processing_ms + NETWORK_BUFFER_MS;

  const requestSpecCanonical = canonicalize({
    capability_id: advertDatum.capability_id,
    max_output_tokens: advertDatum.max_output_tokens,
    model: advertDatum.model,
  });
  const requestSpecHash = sha256Utf8Hex(requestSpecCanonical);

  // prompt_hash: sha256 of the canonical-JSON messages array (RFC-8785 JCS subset).
  // ARCHITECTURE.md §4.2: prompt_hash binds the full OpenAI-style envelope so
  // supplier-side validation in M1-C can verify role/content/system integrity.
  const promptHash = sha256Utf8Hex(canonicalize(messages));

  const economicTotal =
    advertDatum.price_lovelace +
    advertDatum.buyer_bond_lovelace +
    advertDatum.supplier_bond_lovelace;

  const escrowDatum: EscrowDatum = {
    buyer_pkh: buyerKey.pubKeyHash,
    supplier_pkh: advertDatum.supplier_pkh,
    advert_ref: advertRef,
    capability_id: advertDatum.capability_id,
    request_spec_hash: requestSpecHash,
    prompt_hash: promptHash,
    payment_lovelace: advertDatum.price_lovelace,
    buyer_bond_lovelace: advertDatum.buyer_bond_lovelace,
    supplier_bond_lovelace: advertDatum.supplier_bond_lovelace,
    deliver_by: deliverBy,
    posted_at: postedAt,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };

  // Lock enough that the escrow output satisfies min-ada in its LARGEST
  // future state (Submitted) - value_equal on Claim/Submit forbids any
  // later bump (min-ada floor).
  const totalLocked = escrowLockFloor(escrowDatum, economicTotal);

  // Live path: produce real Cardano CBOR via lucid-evolution.
  if (detectCborBackend(chain) === "live") {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForEscrow } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForEscrow({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      advertRef,
      messages,
      escrowDatum,
      totalLocked,
      deliverBy,
      postedAt,
    });
  }

  const blueprint = loadBlueprint();
  const escrowAddress = blueprint.escrowScriptAddress(0);

  const body = {
    type: "post-escrow",
    inputs: [],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: escrowAddress,
        lovelace: totalLocked,
        assets: {},
        datumHex: encodeEscrowDatum(escrowDatum),
        scriptRef: null,
      },
    ],
    requiredSigners: [buyerKey.pubKeyHash],
    validityRange: { lowerBoundMs: postedAt, upperBoundMs: deliverBy },
    meta: { script_hash: blueprint.escrowScriptHash, advert_ref: advertRef },
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    escrowOutputRef: { txHash: expectedTxHash, index: 0 },
  };
}
