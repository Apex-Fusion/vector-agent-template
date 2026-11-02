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
 *   5. exactly one of messages or prompt_hash is provided — TxConstructionError("prompt required" | "ambiguous prompt commitment")
 *   6. validity range hi − lo ≤ 1 h (Part 2 §6.5)
 * A new advert (identity layout) gives a new escrow with the checks of
 * postFromAdvert.ts: listing rule, value cap, agent_id and refund.
 *
 * EscrowDatum derivation:
 *   - prompt_hash is either a supplied 32-byte hex commitment or
 *     sha256(canonical(messages)) per ARCHITECTURE.md §4.2. The messages
 *     path binds the full OpenAI-style array so supplier-side validation can
 *     detect any system-prompt or role tampering.
 *   - request_spec_hash = sha256(canonical({capability_id, max_output_tokens, model}))
 *     using JCS-sorted keys.
 *   - posted_at = chain tip wallclock (mock convention: slot * 1000).
 *   - deliver_by = posted_at + advert.max_processing_ms + 30_000 (network_buffer).
 *   - locked value = price + buyer_bond + supplier_bond.
 */

// Namespace import — see blueprint.ts header.
import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { ChatMessage, WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { postEscrowFromAdvert, type PostEscrowLayoutOptions } from "./postFromAdvert.js";

export interface PostEscrowParams extends PostEscrowLayoutOptions {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  messages?: ChatMessage[];
  /** Precomputed prompt commitment: 32-byte hex, sha256 over whatever canonical
   * envelope the caller and supplier agreed on. When provided, the builder uses
   * it verbatim and does not require or hash messages. */
  prompt_hash?: string;
  payment_lovelace: bigint;
  /** Runs after signing and before any broadcast. Rejection prevents submit. */
  beforeSubmit?: (built: PostEscrowBuildResult) => Promise<void>;
  /** Wallet outputs that a submitted, unconfirmed transaction spends; never selected (live backend). */
  excludeInputs?: readonly OutputReference[];
}

export async function buildPostEscrowTx(
  params: PostEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { messages, prompt_hash } = params;

  if (messages === undefined && prompt_hash === undefined) {
    throw new TxConstructionError(
      "prompt required",
      "provide messages or a precomputed prompt_hash",
    );
  }
  if (messages !== undefined && prompt_hash !== undefined) {
    throw new TxConstructionError(
      "ambiguous prompt commitment",
      "provide either messages or prompt_hash, not both",
    );
  }

  let promptHash: string;
  if (prompt_hash !== undefined) {
    if (!/^[0-9a-fA-F]{64}$/.test(prompt_hash)) {
      throw new TxConstructionError(
        "prompt_hash malformed",
        "prompt_hash must be 32-byte hex",
      );
    }
    promptHash = prompt_hash.toLowerCase();
  } else {
    // Messages must be a non-empty array with valid shape.
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new TxConstructionError("messages required", "messages must be a non-empty array of ChatMessage");
    }
    for (const m of messages) {
      if (!m || typeof m.content !== "string" || m.content.length === 0) {
        throw new TxConstructionError("messages required", "each message must have a non-empty string content");
      }
    }
    promptHash = nodeCrypto.createHash("sha256").update(canonicalize(messages), "utf8").digest("hex");
  }

  return postEscrowFromAdvert({ ...params, promptHash });
}
