/**
 * tx/types.ts — shared types for M1-B tx builders.
 *
 * WalletKey: a minimal representation of a wallet key pair.
 * BuildResult: what every tx builder returns.
 * TxConstructionError: thrown when builder-side invariants are violated.
 *
 * Catherine implements the real logic in M1-B-green; stubs in sibling files
 * throw Error("not implemented — M1-B-green") until then.
 */

import type { OutputReference } from "../chain/ChainProvider.js";

/**
 * ToolCall — OpenAI-compatible function tool call emitted by an assistant turn.
 * `function.arguments` is the raw JSON string as produced by the model.
 */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * ChatMessage — OpenAI-compatible chat message.
 * `content` is always a string ("" for tool-call-only assistant messages —
 * OpenAI's `content: null` is normalized on ingest). `tool_calls` /
 * `tool_call_id` MUST be omitted (not set to undefined) when absent: the
 * receipt hash canonicalizes the transcript objects, so field presence is
 * part of the identity shared between supplier transcript and gateway mirror.
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/**
 * WalletKey — an Ed25519 key pair for signing transactions.
 * pubKeyHash is the 28-byte blake2b-224(pubKey) as lowercase hex.
 * privateKeyHex and pubKeyHex are 32-byte / 32-byte raw Ed25519 keys as hex.
 */
export interface WalletKey {
  pubKeyHash: string;       // 28-byte hex (VerificationKeyHash on-chain)
  pubKeyHex: string;        // 32-byte hex Ed25519 public key
  privateKeyHex: string;    // 32-byte hex Ed25519 private key (test-only; never log)
  address: string;          // bech32 payment address (addr_test1... or addr1...)
}

/**
 * BuildResult — returned by every successful tx builder call.
 * txCborHex is the signed (or partially signed) Cardano tx serialised as CBOR hex.
 * expectedTxHash is sha256(txCborHex) as 64-char hex (for awaitTx in tests).
 */
export interface BuildResult {
  txCborHex: string;
  expectedTxHash: string;
}

/**
 * PostAdvertBuildResult — BuildResult with the newly created advert OutputReference.
 */
export interface PostAdvertBuildResult extends BuildResult {
  advertOutputRef: OutputReference;
}

/**
 * PostEscrowBuildResult — BuildResult with the newly created escrow OutputReference.
 */
export interface PostEscrowBuildResult extends BuildResult {
  escrowOutputRef: OutputReference;
}

/**
 * TxConstructionError — thrown by tx builders when builder-enforced invariants
 * (e.g. signature mismatch, wrong datum state, invalid timestamps) are violated.
 * These are off-chain checks that the on-chain validator cannot enforce at creation.
 *
 * The `reason` field carries a machine-readable identifier (snake_case string)
 * that tests assert against.  The human message is in `message` (inherited from Error).
 */
export class TxConstructionError extends Error {
  public readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "TxConstructionError";
    this.reason = reason;
  }
}
