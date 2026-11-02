/**
 * tx/index.ts — public exports for M1-B tx builders.
 */

export type { ChatMessage, ToolCall, WalletKey, BuildResult, PostAdvertBuildResult, PostEscrowBuildResult } from "./types.js";
export { TxConstructionError } from "./types.js";
export {
  BOUNDED_INPUT_DETAIL_MARKER,
} from "./inputBound.js";
export {
  mockSlotToWallclockMs,
  mockWallclockMsToSlot,
  NETWORK_BUFFER_MS,
  MAX_RANGE_MS,
  ESCROW_VALUE_CAP_LOVELACE,
  ESCROW_INPUT_CAP_LOVELACE,
} from "./internal/constants.js";
export { detectCborBackend, type CborBackend } from "./internal/cborBackend.js";
export { escrowLockFloor, minAdaForEscrowDatum } from "./internal/minAdaFloor.js";
export type { Signer } from "./signer.js";
export { MockSigner } from "./signer.js";
export type { Blueprint, IdentityBlueprint, IdentityBlueprintOptions } from "./blueprint.js";
export { loadBlueprint, loadIdentityBlueprint } from "./blueprint.js";
// Parameter application (byte-equal to `aiken blueprint apply`) and Plutus V3 script hashes.
export { applyDataParameter, plutusV3ScriptHash } from "./internal/plutusScript.js";

// Both layouts during the drain (Part 2 §9.6): the datum decides.
export type { MarketplaceLayout } from "./internal/layout.js";
export { isIdentityAdvertDatum, isIdentityEscrowDatum } from "./internal/layout.js";

// Identity checks of the new escrow and advert builders (Part 2 §6.1, §6.2).
export type { RecordLookup, AdvertSignersLookup, EffectiveStatus, AgentWorkCheck } from "./identityRecord.js";
export {
  readAgentRecord,
  rootEffectiveStatus,
  recordHasKey,
  agentWorkProblem,
  assertAgentCanWork,
} from "./identityRecord.js";
// Note: live-CBOR helpers (loadEscrowScript, loadAdvertScript,
// buildLiveTxForPublishReferenceScripts, pkhToEnterpriseAddress) live in
// "./server.js" — kept OUT of this index so the buyer's vite bundle
// doesn't trace into lucid-evolution / CML WASM (sibling builders use
// /* @vite-ignore */ dynamic imports for the same reason).

// Advert builders
export type { PostAdvertParams } from "./advert/postAdvert.js";
export { buildPostAdvertTx } from "./advert/postAdvert.js";
export type { UpdateAdvertParams } from "./advert/updateAdvert.js";
export { buildUpdateAdvertTx } from "./advert/updateAdvert.js";
export type { RetireAdvertParams } from "./advert/retireAdvert.js";
export { buildRetireAdvertTx } from "./advert/retireAdvert.js";

// Escrow builders
export type { PostEscrowLayoutOptions } from "./escrow/postFromAdvert.js";
export type { PostEscrowParams } from "./escrow/postEscrow.js";
export { buildPostEscrowTx } from "./escrow/postEscrow.js";
export type { PostTtsEscrowParams, TtsRequest } from "./escrow/postTtsEscrow.js";
export {
  buildPostTtsEscrowTx,
  ttsPromptHash,
  ALLOWED_TTS_VOICES,
  ALLOWED_TTS_FORMATS,
} from "./escrow/postTtsEscrow.js";
export type { PostChatEscrowParams } from "./escrow/postChatEscrow.js";
export { buildPostChatEscrowTx, chatSessionPromptHash } from "./escrow/postChatEscrow.js";
export type { PostOcrEscrowParams, OcrRequest } from "./escrow/postOcrEscrow.js";
export {
  buildPostOcrEscrowTx,
  ocrPromptHash,
  validateOcrRequest,
  ALLOWED_OCR_MIMES,
  ALLOWED_OCR_OUTPUT_FORMATS,
  MAX_OCR_IMAGE_B64_CHARS,
} from "./escrow/postOcrEscrow.js";
export type { ClaimParams } from "./escrow/claim.js";
export { buildClaimTx } from "./escrow/claim.js";
export type { SubmitParams } from "./escrow/submit.js";
export { buildSubmitTx } from "./escrow/submit.js";
export type { AcceptParams } from "./escrow/accept.js";
export { buildAcceptTx, ACCEPT_WINDOW_MS } from "./escrow/accept.js";
export type { ReclaimParams } from "./escrow/reclaim.js";
export { buildReclaimTx } from "./escrow/reclaim.js";
export type { ReleaseParams } from "./escrow/release.js";
export { buildReleaseTx } from "./escrow/release.js";
export type { RefundRevokedParams } from "./escrow/refundRevoked.js";
export { buildRefundRevokedTx } from "./escrow/refundRevoked.js";
export { refundAllowed } from "./escrow/identityEscrow.js";
