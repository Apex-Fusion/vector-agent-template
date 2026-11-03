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
 * A new advert (identity layout) gives a new escrow with the checks of
 * postFromAdvert.ts: listing rule, value cap, agent_id and refund.
 */

import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { postEscrowFromAdvert, type PostEscrowLayoutOptions } from "./postFromAdvert.js";

export interface PostChatEscrowParams extends PostEscrowLayoutOptions {
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
  const { session_nonce } = params;

  // 5. session_nonce must be a non-empty string.
  if (typeof session_nonce !== "string" || session_nonce.length === 0) {
    throw new TxConstructionError("session_nonce required",
      "session_nonce must be a non-empty string");
  }

  return postEscrowFromAdvert({
    chain: params.chain,
    buyerKey: params.buyerKey,
    advertRef: params.advertRef,
    // The on-chain commitment is the session-init prompt_hash; the
    // conversation runs off-chain after the escrow exists.
    promptHash: chatSessionPromptHash({ session_nonce }),
    payment_lovelace: params.payment_lovelace,
    escrowLayout: params.escrowLayout,
    lookupRecord: params.lookupRecord,
    lookupAdvertSigners: params.lookupAdvertSigners,
    identityBlueprint: params.identityBlueprint,
  });
}
