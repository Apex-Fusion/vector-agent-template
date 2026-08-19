/**
 * supplier/src/routes/chat.ts — POST /v1/chat/completions handler.
 *
 * Full validation flow:
 *   1. Header/body validation (X-Escrow-Ref, stream, tools, messages, max_output_tokens)
 *   2. On-chain escrow validation (state, supplier_pkh, capability_id,
 *      request_spec_hash, prompt_hash, deliver_by)
 *   3. Single-slot lock (tryAcquire)
 *   4. Submit Claim tx
 *   5. Call Ollama
 *   6. Build + sign receipt
 *   7. Submit Submit tx
 *   8. Release lock
 *   9. Return 200 with OpenAI-compat response + receipt + signature
 *
 * Error recovery:
 *   - Claim tx submit fails → release lock → 503 chain_submit_failed
 *   - Ollama fails after Claim → release lock → 502 ollama_failure
 *     (escrow stuck in Claimed; v1 recovery is buyer reclaim after deliver_by)
 *   - Submit tx fails → release lock → 502 submit_failed
 *
 * Stub — throws until M1-C-green implementation lands.
 */

export {};
