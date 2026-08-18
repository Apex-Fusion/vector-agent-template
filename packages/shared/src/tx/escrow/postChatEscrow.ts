/**
 * tx/escrow/postChatEscrow.ts — PostEscrow tx builder for the
 * `llm.chat.v1` (multi-turn chat session) capability.
 *
 * Unlike the one-off `postEscrow.ts` (chat) builder, no conversation exists
 * yet at Start-chat time — the buyer opens the escrow BEFORE exchanging any
 * messages and the whole conversation then runs off-chain. So we cannot hash
 * the messages into `prompt_hash` here. Instead we commit a deterministic
 * SESSION-INIT placeholder:
 *
 *   prompt_hash = sha256(canonical({ kind: "llm.chat.v1", session_nonce }))
 *
 * The on-chain validator never reads `prompt_hash` (it only pins it immutable
 * through the state machine — see contracts/marketplace/validators/escrow.ak),
 * so the placeholder is sound. At End-chat the supplier commits the real
 * transcript hash as `result_receipt_hash` via the normal Submit tx, and the
 * buyer verifies the signed receipt off-chain (recomputing this same
 * session-init hash from the nonce it remembers).
 *
 * `chatSessionPromptHash` is exported and shared between the buyer (here) and
 * the supplier (server.ts /v1/chat/start), exactly like `ttsPromptHash` — both
 * sides must agree on the canonicalisation or the supplier's prompt-mismatch
 * gate fails.
 *
 * Off-chain invariants (mirror chat/TTS):
 *   1. advert UTxO exists at advertRef
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. session_nonce is a non-empty string
 */

import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { EscrowDatum } from "../../cbor/types.js";
import { decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { loadBlueprint } from "../blueprint.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { mockSlotToWallclockMs, NETWORK_BUFFER_MS } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { escrowLockFloor } from "../internal/minAdaFloor.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export interface PostChatEscrowParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  /** Random hex the buyer generates and remembers for End-chat verification. */
  session_nonce: string;
  payment_lovelace: bigint;
}

function sha256Utf8Hex(s: string): string {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Session-init prompt_hash, shared between buyer (postChatEscrow) and supplier
 * (/v1/chat/start). Both sides MUST agree on this exact JCS-canonical encoding. */
export function chatSessionPromptHash(args: { session_nonce: string }): string {
  return sha256Utf8Hex(canonicalize({
    kind: "llm.chat.v1",
    session_nonce: args.session_nonce,
  }));
}

export async function buildPostChatEscrowTx(
  params: PostChatEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, advertRef, session_nonce, payment_lovelace } = params;

  // 5. session_nonce must be a non-empty string.
  if (typeof session_nonce !== "string" || session_nonce.length === 0) {
    throw new TxConstructionError("session_nonce required",
      "session_nonce must be a non-empty string");
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

  // Time source: same convention as chat/TTS.
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
  const promptHash = chatSessionPromptHash({ session_nonce });

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

  // Live path: reuse the capability-agnostic chat builder (messages = []).
  // The on-chain commitment is the escrowDatum (carrying our session-init
  // prompt_hash); messages are only used for the mock cbor body, which we omit.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForEscrow } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForEscrow({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      advertRef,
      messages: [],
      escrowDatum,
      totalLocked,
      deliverBy,
      postedAt,
    });
  }

  // Mock backend path (synthetic JSON-in-hex tx body).
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
