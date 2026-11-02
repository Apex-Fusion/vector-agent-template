/**
 * tx/escrow/postOcrEscrow.ts — PostEscrow tx builder for model-scoped OCR
 * capabilities (`ocr.page.extract.<model-slug>.v1`, one page per job).
 *
 * Accepts either the OCR request envelope or a precomputed prompt_hash. The
 * request path hashes canonical `{image_b64, mime, output_format}`, the same
 * object the supplier hashes when validating POST /v1/ocr/extract.
 *
 * The image travels off-chain (buyer → supplier HTTP body); the chain only
 * ever carries prompt_hash. Never place image bytes or extracted text in a
 * datum.
 *
 * Off-chain invariants (mirror TTS's, with OCR-shaped body validation):
 *   1. advert UTxO exists at advertRef
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. exactly one of request or prompt_hash is provided
 *   6. a supplied prompt_hash is 32-byte hex, or request passes OCR validation
 * A new advert (identity layout) gives a new escrow with the checks of
 * postFromAdvert.ts: listing rule, value cap, agent_id and refund.
 */

import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import { canonicalize } from "../../cbor/canonical.js";
import type { WalletKey, PostEscrowBuildResult } from "../types.js";
import { TxConstructionError } from "../types.js";
import { postEscrowFromAdvert, type PostEscrowLayoutOptions } from "./postFromAdvert.js";

/** OCR request envelope. The buyer-side hash and the supplier-side hash
 * MUST agree on this exact set of keys, in this exact JCS-canonical
 * encoding, or the supplier will reject with `prompt_mismatch`. */
export interface OcrRequest {
  /** Plain base64 of the page image bytes. No `data:` prefix. */
  image_b64: string;
  /** Image content type. */
  mime: string;
  /** Requested extraction output shape. */
  output_format: string;
}

export const ALLOWED_OCR_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp",
]);
export const ALLOWED_OCR_OUTPUT_FORMATS = new Set(["markdown", "html", "json"]);

/**
 * Upper bound on the base64 payload, in characters (~9 MB of image bytes).
 * A 300-DPI page scan lands around 0.5–3 MB binary; this cap protects the
 * supplier's JSON body parser and the off-chain transport, not the chain
 * (the chain only sees the 32-byte hash).
 */
export const MAX_OCR_IMAGE_B64_CHARS = 12_000_000;

/** Plain base64 (standard alphabet, optional padding). Rejects data URLs,
 * whitespace and base64url — one canonical encoding, one hash. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export interface PostOcrEscrowParams extends PostEscrowLayoutOptions {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  request?: OcrRequest;
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
export function ocrPromptHash(req: OcrRequest): string {
  return sha256Utf8Hex(canonicalize({
    image_b64: req.image_b64,
    mime: req.mime,
    output_format: req.output_format,
  }));
}

/** Body validation shared conceptually with the supplier route. Throws
 * TxConstructionError with a machine-readable reason. */
export function validateOcrRequest(request: OcrRequest): void {
  if (typeof request?.image_b64 !== "string" || request.image_b64.length === 0) {
    throw new TxConstructionError("image required",
      "request.image_b64 must be a non-empty base64 string");
  }
  if (request.image_b64.length > MAX_OCR_IMAGE_B64_CHARS) {
    throw new TxConstructionError("image too large",
      `request.image_b64 exceeds ${MAX_OCR_IMAGE_B64_CHARS} chars`);
  }
  if (!BASE64_RE.test(request.image_b64)) {
    throw new TxConstructionError("image not base64",
      "request.image_b64 must be plain base64 (no data: prefix, no whitespace)");
  }
  if (!ALLOWED_OCR_MIMES.has(request.mime)) {
    throw new TxConstructionError("mime invalid",
      `mime must be one of: ${[...ALLOWED_OCR_MIMES].join(", ")}`);
  }
  if (!ALLOWED_OCR_OUTPUT_FORMATS.has(request.output_format)) {
    throw new TxConstructionError("output_format invalid",
      `output_format must be one of: ${[...ALLOWED_OCR_OUTPUT_FORMATS].join(", ")}`);
  }
}

export async function buildPostOcrEscrowTx(
  params: PostOcrEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { request, prompt_hash } = params;

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
  } else if (request !== undefined) {
    validateOcrRequest(request);
    promptHash = ocrPromptHash(request);
  } else {
    throw new TxConstructionError(
      "request required",
      "provide request or a precomputed prompt_hash",
    );
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
