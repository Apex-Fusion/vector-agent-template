/**
 * supplier/src/chatSession.ts — in-memory store for open multi-turn chat
 * sessions (capabilityKind="chat-session", capability_id="llm.chat.v1").
 *
 * Unlike the one-off JobStore (one request → one terminal payload), a chat
 * session is long-lived: it's created at /v1/chat/start (after the supplier
 * Claims the escrow), accumulates a transcript across many /v1/chat/message
 * turns that run fully OFF-CHAIN, and is settled at /v1/chat/end (or by the
 * idle watchdog) when the supplier Submits a receipt over the whole transcript.
 *
 * Concurrency: up to MAX_CHAT_SESSIONS records are "active" at once
 * (SupplierState slot admission). Ended records are retained so /v1/chat/end
 * is idempotent (returns the same receipt) and so a used ticket-mode escrow
 * ref can never open a second session.
 *
 * Timer handles (idle + hard-cap) live on the record; server.ts arms them and
 * endChatSession clears them.
 */

import type { OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import type { ResponseItem, ResponseObject } from "@marketplace/shared/responses";

export type ChatSessionStatus = "active" | "ending" | "ended";

export interface ChatSessionEndResult {
  receipt: Record<string, unknown>;
  receipt_signature: string;
  /** The Submitted escrow UTxO ("<txHash>#<index>") the buyer must Accept. */
  submitted_ref: string;
}

export interface ChatSessionRecord {
  escrowRef: string;
  /** Absent in ticket mode (the escrow is never Claimed). */
  claimedRef?: OutputReference;
  /** "full" = Claim/Submit lifecycle; "ticket" = no chain ops after the
   * buyer's escrow post. */
  settleMode: "full" | "ticket";
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
  /** Full ordered Responses item transcript. Hashed at End. */
  transcript: ResponseItem[];
  promptTokens: number;
  completionTokens: number;
  startedAtMs: number;
  lastActivityMs: number;
  status: ChatSessionStatus;
  /** Prevents overlapping turns from interleaving one transcript. */
  turnInFlight?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  hardCapTimer?: ReturnType<typeof setTimeout>;
  endResult?: ChatSessionEndResult;
  endFailure?: { reason: string; message: string };
}

export interface CreateChatSessionParams {
  escrowRef: string;
  claimedRef?: OutputReference;
  settleMode?: "full" | "ticket";
  advert: AdvertDatum;
  escrowDatum: EscrowDatum;
}

export class ChatSessionStore {
  private readonly records = new Map<string, ChatSessionRecord>();

  create(params: CreateChatSessionParams): ChatSessionRecord {
    const now = Date.now();
    const record: ChatSessionRecord = {
      escrowRef: params.escrowRef,
      claimedRef: params.claimedRef,
      settleMode: params.settleMode ?? "full",
      advert: params.advert,
      escrowDatum: params.escrowDatum,
      transcript: [],
      promptTokens: 0,
      completionTokens: 0,
      startedAtMs: now,
      lastActivityMs: now,
      status: "active",
    };
    this.records.set(params.escrowRef, record);
    return record;
  }

  get(escrowRef: string): ChatSessionRecord | null {
    return this.records.get(escrowRef) ?? null;
  }

  /** True iff there is a record in "active" or "ending" state for this ref. */
  isOpen(escrowRef: string): boolean {
    const r = this.records.get(escrowRef);
    return r !== undefined && r.status !== "ended";
  }

  /** Append a whole turn delta verbatim. */
  appendInput(escrowRef: string, input: ResponseItem[]): void {
    const r = this.records.get(escrowRef);
    if (!r) return;
    r.transcript.push(...input);
    r.lastActivityMs = Date.now();
  }

  /** Append a validated terminal response atomically. */
  appendResponse(escrowRef: string, response: ResponseObject): void {
    const r = this.records.get(escrowRef);
    if (!r) return;
    r.transcript.push(...response.output);
    r.promptTokens += response.usage?.input_tokens ?? 0;
    r.completionTokens += response.usage?.output_tokens ?? 0;
    r.lastActivityMs = Date.now();
  }

  /** Roll back a failed turn: truncate the transcript to `length`. The gateway
   * mirror only appends after a successful turn, so the delta appended at turn
   * start must be removed on LLM failure to keep both sides hash-identical. */
  truncateTranscript(escrowRef: string, length: number): void {
    const r = this.records.get(escrowRef);
    if (!r || length < 0 || r.transcript.length <= length) return;
    r.transcript.length = length;
    r.lastActivityMs = Date.now();
  }

  touch(escrowRef: string): void {
    const r = this.records.get(escrowRef);
    if (r) r.lastActivityMs = Date.now();
  }

  clearTimers(record: ChatSessionRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = undefined;
    }
    if (record.hardCapTimer) {
      clearTimeout(record.hardCapTimer);
      record.hardCapTimer = undefined;
    }
  }

  count(): number {
    return this.records.size;
  }
}
