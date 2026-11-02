/**
 * tx/escrow/postTtsEscrow.ts — PostEscrow tx builder for the
 * `audio.synthesize.piper.v1` capability.
 *
 * Accepts either the TTS request envelope or a precomputed prompt_hash. The
 * request path hashes canonical `{text, voice, format, speed}`, the same object
 * the supplier hashes when validating POST /v1/audio/synthesize.
 *
 * Off-chain invariants (mirror chat's, with TTS-shaped body validation):
 *   1. advert UTxO exists at advertRef
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. exactly one of request or prompt_hash is provided
 *   6. a supplied prompt_hash is 32-byte hex, or request passes TTS validation
 * A new advert (identity layout) gives a new escrow with the checks of
 * postFromAdvert.ts: listing rule, value cap, agent_id and refund.
 */

import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { postEscrowFromAdvert, type PostEscrowLayoutOptions } from "./postFromAdvert.js";

/** TTS request envelope. The buyer-side hash and the supplier-side hash
 * MUST agree on this exact set of keys, in this exact JCS-canonical
 * encoding, or the supplier will reject with `prompt_mismatch`. */
export interface TtsRequest {
  text: string;
  voice: string;
  format: string;
  speed: number;
}

export const ALLOWED_TTS_VOICES = new Set([
  "alloy", "echo", "fable", "onyx", "nova", "shimmer", "lessac",
]);
export const ALLOWED_TTS_FORMATS = new Set(["mp3", "wav", "opus", "aac", "flac"]);

export interface PostTtsEscrowParams extends PostEscrowLayoutOptions {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  request?: TtsRequest;
  /** Precomputed prompt commitment: 32-byte hex, sha256 over whatever canonical
   * envelope the caller and supplier agreed on. When provided, the builder uses
   * it verbatim and does not require or hash request. */
  prompt_hash?: string;
  payment_lovelace: bigint;
}

function sha256Utf8Hex(s: string): string {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Hash function shared between buyer (here) and supplier (server.ts).
 * Exported so unit tests on either side can pin the canonicalisation. */
export function ttsPromptHash(req: TtsRequest): string {
  return sha256Utf8Hex(canonicalize({
    text: req.text,
    voice: req.voice,
    format: req.format,
    speed: req.speed,
  }));
}

export async function buildPostTtsEscrowTx(
  params: PostTtsEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { request, prompt_hash } = params;

  if (request === undefined && prompt_hash === undefined) {
    throw new TxConstructionError(
      "request required",
      "provide request or a precomputed prompt_hash",
    );
  }
  if (request !== undefined && prompt_hash !== undefined) {
    throw new TxConstructionError(
      "ambiguous prompt commitment",
      "provide either request or prompt_hash, not both",
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
    if (typeof request?.text !== "string" || request.text.length === 0) {
      throw new TxConstructionError("text required",
        "request.text must be a non-empty string");
    }
    if (!ALLOWED_TTS_VOICES.has(request.voice)) {
      throw new TxConstructionError("voice invalid",
        `voice must be one of: ${[...ALLOWED_TTS_VOICES].join(", ")}`);
    }
    if (!ALLOWED_TTS_FORMATS.has(request.format)) {
      throw new TxConstructionError("format invalid",
        `format must be one of: ${[...ALLOWED_TTS_FORMATS].join(", ")}`);
    }
    if (!Number.isFinite(request.speed) || request.speed < 0.5 || request.speed > 1.5) {
      throw new TxConstructionError("speed out of range",
        "speed must be a finite number in [0.5, 1.5]");
    }
    promptHash = ttsPromptHash(request);
  }

  return postEscrowFromAdvert({
    chain: params.chain,
    buyerKey: params.buyerKey,
    advertRef: params.advertRef,
    promptHash,
    payment_lovelace: params.payment_lovelace,
    escrowLayout: params.escrowLayout,
    lookupRecord: params.lookupRecord,
    lookupAdvertSigners: params.lookupAdvertSigners,
    identityBlueprint: params.identityBlueprint,
  });
}
