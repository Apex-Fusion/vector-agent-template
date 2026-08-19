/**
 * tx/escrow/postTtsEscrow.ts — PostEscrow tx builder for the
 * `audio.synthesize.piper.v1` capability.
 *
 * Mirrors `postEscrow.ts` (chat) but commits a TTS-shaped prompt_hash
 * over the canonicalised request envelope `{text, voice, format, speed}`
 * — the SAME object the supplier hashes when validating the incoming
 * POST /v1/audio/synthesize body. Any mismatch on either side fails the
 * supplier-side prompt_mismatch gate.
 *
 * Off-chain invariants (mirror chat's, with TTS-shaped body validation):
 *   1. advert UTxO exists at advertRef
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. body.text is a non-empty string
 *   6. body.voice ∈ ALLOWED_VOICES
 *   7. body.format ∈ ALLOWED_FORMATS
 *   8. body.speed is finite and ∈ [0.5, 1.5]
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

export interface PostTtsEscrowParams {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  request: TtsRequest;
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
  const { chain, buyerKey, advertRef, request, payment_lovelace } = params;

  // 5. Body validation.
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

  // Time source: same convention as chat.
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
  const promptHash = ttsPromptHash(request);

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

  // Live path: reuse the chat builder. The live cbor path is already
  // capability-agnostic — `messages` is `void`-marked there. We pass an
  // empty array so the type checker is satisfied; the actual on-chain
  // commitment is the escrowDatum (which carries our TTS prompt_hash).
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
