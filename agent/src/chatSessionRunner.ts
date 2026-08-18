/**
 * supplier/src/chatSessionRunner.ts — ends an open chat session.
 *
 * endChatSession is invoked from BOTH /v1/chat/end (user clicked "End chat")
 * and the idle/hard-cap watchdog (abandoned session). Behavior branches on
 * the record's settleMode:
 *
 *   full   — chat-session analogue of runChatJob's receipt+Submit tail:
 *            build + sign a receipt over the FULL transcript
 *            (response_hash = sha256(canonical(transcript))), then
 *            buildSubmitTx against the Claimed UTxO → awaitTx (60s), inside
 *            the wallet mutex (never race another wallet spend).
 *   ticket — no chain work at all: mark ended and free the slot. The escrow
 *            was never Claimed; the buyer's sweeper Reclaims it after
 *            deliver_by.
 *
 * Never throws. On any failure the session is marked "ended" with endFailure
 * and the slot is released (a full-mode escrow then lingers Claimed until the
 * buyer Reclaims after deliver_by — same fate as a failed one-off job).
 */

import { canonicalize } from "@marketplace/shared/cbor";
import { buildSubmitTx } from "@marketplace/shared/tx";
import { buildReceipt, signReceipt, receiptResultHash } from "@marketplace/shared/receipt";
import { createHash } from "crypto";

import type { RunChatJobDeps } from "./jobRunner.js";
import type { ChatSessionStore, ChatSessionRecord } from "./chatSession.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface EndChatSessionDeps extends RunChatJobDeps {
  sessions: ChatSessionStore;
}

export interface EndChatSessionParams {
  deps: EndChatSessionDeps;
  escrowRef: string;
  /** Identifies what triggered the end, for logs ("end" | "idle" | "hard-cap"). */
  trigger?: string;
}

/**
 * End a chat session. Returns the (now terminal) record, or null if no
 * session exists for the ref. Idempotent: a second call returns the same
 * record without re-submitting.
 */
export async function endChatSession(
  params: EndChatSessionParams,
): Promise<ChatSessionRecord | null> {
  const { deps, escrowRef, trigger } = params;
  const record = deps.sessions.get(escrowRef);
  if (!record) return null;

  // Single-threaded between awaits: this check-then-set is atomic enough to
  // dedupe concurrent end/idle triggers.
  if (record.status !== "active") return record;
  record.status = "ending";
  deps.sessions.clearTimers(record);

  try {
    if (record.settleMode === "ticket") {
      // No chain work: the un-Claimed escrow is the buyer's to reclaim.
      record.status = "ended";
      return record;
    }
    const claimedRef = record.claimedRef;
    if (!claimedRef) {
      // Full-mode record without a Claim ref should be impossible; end
      // defensively rather than throw (this path must never leak the slot).
      console.warn(`[chat_end_failed] escrow=${escrowRef} trigger=${trigger ?? "end"} reason=missing_claimed_ref`);
      record.endFailure = { reason: "missing_claimed_ref", message: "full-mode session has no claimedRef" };
      record.status = "ended";
      return record;
    }

    // ── Receipt over the full transcript ──────────────────────────────────
    const transcriptHash = sha256Hex(canonicalize(record.transcript));
    const receipt = buildReceipt({
      prompt_hash: record.escrowDatum.prompt_hash, // session-init placeholder
      response_hash: transcriptHash,
      model: record.advert.model,
      prompt_tokens: record.promptTokens,
      completion_tokens: record.completionTokens,
      wallclock_ms: Math.max(0, Date.now() - record.startedAtMs),
      supplier_pkh: deps.supplierKey.pubKeyHash,
      escrow_ref: record.escrowRef,
    });
    const signed = signReceipt(receipt, deps.supplierKey.privateKeyHex);
    const resultHash = receiptResultHash(signed);

    // ── Submit (Claimed → Submitted): one wallet critical section ─────────
    const submitOutcome = await deps.state.walletMutex.run(async () => {
      let built: { txCborHex: string; expectedTxHash: string };
      try {
        built = await buildSubmitTx({
          chain: deps.chain,
          supplierKey: deps.supplierKey,
          escrowRef: claimedRef,
          receiptHash: resultHash,
        });
      } catch (err) {
        return { kind: "build_failed" as const, err };
      }
      try {
        await deps.chain.awaitTx(built.expectedTxHash, 60_000);
      } catch (err) {
        return { kind: "await_failed" as const, err };
      }
      return { kind: "ok" as const, built };
    });
    if (submitOutcome.kind === "build_failed") {
      const message = submitOutcome.err instanceof Error ? submitOutcome.err.message : String(submitOutcome.err);
      console.warn(`[chat_end_failed] escrow=${escrowRef} trigger=${trigger ?? "end"} reason=submit_failed msg=${message}`);
      record.endFailure = { reason: "submit_failed", message: `Submit tx failed: ${message}` };
      record.status = "ended";
      return record;
    }
    if (submitOutcome.kind === "await_failed") {
      const message = submitOutcome.err instanceof Error ? submitOutcome.err.message : String(submitOutcome.err);
      console.warn(`[chat_end_failed] escrow=${escrowRef} trigger=${trigger ?? "end"} reason=submit_timeout msg=${message}`);
      record.endFailure = { reason: "submit_timeout", message: `Submit awaitTx failed: ${message}` };
      record.status = "ended";
      return record;
    }

    record.endResult = {
      receipt: signed.receipt as unknown as Record<string, unknown>,
      receipt_signature: signed.signature,
      // The Submit tx output (index 0) is the new Submitted UTxO the buyer Accepts.
      submitted_ref: `${submitOutcome.built.expectedTxHash}#0`,
    };
    record.status = "ended";
    return record;
  } finally {
    // Always release this session's slot so the next chat can start.
    try {
      deps.state.release(record.escrowRef);
    } catch {
      /* never let lock-release escape */
    }
  }
}
