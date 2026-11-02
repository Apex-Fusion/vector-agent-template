/**
 * receipt/build.ts — Build a Receipt object from inference results.
 *
 * Receipt schema per ARCHITECTURE.md §5.1:
 *   { prompt_hash, response_hash, model, prompt_tokens, completion_tokens,
 *     wallclock_ms, supplier_pkh, escrow_ref }
 * A receipt for a new escrow (Part 2 §6.3) has a 9th field:
 *   agent_did = "did:vector:<agent_id>"
 * A receipt for a legacy escrow keeps the 8 fields. Signing and hashing do not change.
 *
 * response_hash = sha256(canonical(<the assistant message object>))
 * escrow_ref    = "<64-char-hex>#<index>"
 *
 * Field order in the returned object is deliberate — it matches the schema
 * declaration order so callers (and the canonical-JSON hasher) see a stable,
 * documented shape. canonicalize() sorts keys regardless, but tests assert
 * field presence/values so we keep declaration order for readability.
 */

import { parseVectorDid } from "../identity/id.js";

const HEX32_RE = /^[0-9a-fA-F]{64}$/;
const ESCROW_REF_RE = /^[0-9a-fA-F]{64}#(?:0|[1-9]\d*)$/;

export interface Receipt {
  prompt_hash: string;        // 32-byte hex
  response_hash: string;      // 32-byte hex
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
  supplier_pkh: string;       // 28-byte hex
  escrow_ref: string;         // "<txHash>#<index>"
  /** "did:vector:<agent_id>"; present only for a new escrow. */
  agent_did?: string;
}

export interface BuildReceiptParams {
  prompt_hash: string;
  response_hash: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  wallclock_ms: number;
  supplier_pkh: string;
  escrow_ref: string;
  /** Set for a new escrow: "did:vector:<agent_id>" of the escrow's agent_id. */
  agent_did?: string;
}

function assertHex32(name: string, value: string): void {
  if (typeof value !== "string" || !HEX32_RE.test(value)) {
    throw new Error(`buildReceipt: ${name} must be a 32-byte (64-char) hex string`);
  }
}

export function buildReceipt(params: BuildReceiptParams): Receipt {
  assertHex32("prompt_hash", params.prompt_hash);
  assertHex32("response_hash", params.response_hash);

  if (typeof params.model !== "string" || params.model.length === 0) {
    throw new Error("buildReceipt: model must be a non-empty string");
  }
  if (typeof params.supplier_pkh !== "string" || params.supplier_pkh.length === 0) {
    throw new Error("buildReceipt: supplier_pkh must be a non-empty string");
  }
  if (typeof params.escrow_ref !== "string" || !ESCROW_REF_RE.test(params.escrow_ref)) {
    throw new Error(
      'buildReceipt: escrow_ref must match "<64-char-hex>#<non-negative-int>"',
    );
  }
  if (!Number.isFinite(params.prompt_tokens) || params.prompt_tokens < 0) {
    throw new Error("buildReceipt: prompt_tokens must be a non-negative number");
  }
  if (!Number.isFinite(params.completion_tokens) || params.completion_tokens < 0) {
    throw new Error("buildReceipt: completion_tokens must be a non-negative number");
  }
  if (!Number.isFinite(params.wallclock_ms) || params.wallclock_ms < 0) {
    throw new Error("buildReceipt: wallclock_ms must be a non-negative number");
  }
  if (params.agent_did !== undefined && parseVectorDid(params.agent_did)?.form !== "canonical") {
    throw new Error('buildReceipt: agent_did must be "did:vector:<64 lowercase hex characters>"');
  }

  const receipt: Receipt = {
    prompt_hash: params.prompt_hash,
    response_hash: params.response_hash,
    model: params.model,
    prompt_tokens: params.prompt_tokens,
    completion_tokens: params.completion_tokens,
    wallclock_ms: params.wallclock_ms,
    supplier_pkh: params.supplier_pkh,
    escrow_ref: params.escrow_ref,
  };
  if (params.agent_did !== undefined) receipt.agent_did = params.agent_did;
  return receipt;
}
