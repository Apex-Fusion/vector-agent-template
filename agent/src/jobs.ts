/**
 * supplier/src/jobs.ts — In-memory JobStore for async chat jobs.
 *
 * M1-F-async-chat-green — Catherine, 2026-04-28.
 *
 * Lifecycle: create → setRunning → complete | fail → (TTL elapses) → evict.
 *
 * Semantics (pinned by Caroline's RED tests):
 *   - create(escrowRef): UUIDv4 jobId; record starts in "accepted".
 *   - setRunning(id): accepted → running. No-op if already running or terminal.
 *     Does NOT set terminalAtMs.
 *   - complete(id, payload): running → done. No-op on unknown OR already-terminal
 *     (preserves first payload). Sets terminalAtMs = Date.now().
 *   - fail(id, failure): running → failed. Same no-op semantics as complete.
 *     Sets terminalAtMs = Date.now().
 *   - evictExpired(now): removes records where terminalAtMs is set AND
 *     (now - terminalAtMs) > JOB_TTL_MS. Strictly greater-than (not >=).
 *     Running and accepted records are NEVER evicted regardless of age.
 *   - get(id): returns the record or null.
 *   - count(): current map size.
 *
 * NOTE: If the supplier process restarts mid-job, in-memory state is lost.
 * The on-chain escrow remains in `Claimed` state until either the supplier
 * recovers (out of scope for v1) or the buyer `Reclaim`s after `deliver_by`.
 */

export type JobStatus = "accepted" | "running" | "done" | "failed";

/**
 * Chat-flavoured terminal payload. Stored when a `runChatJob` succeeds.
 * Shape mirrors the OpenAI chat-completion response so the buyer-side SDK
 * can parse it without translation.
 */
export interface ChatJobResponsePayload {
  kind?: "chat";
  choices: Array<{
    index: number;
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  receipt: Record<string, unknown>;
  receipt_signature: string;
}

/**
 * TTS-flavoured terminal payload. Stored when a `runTtsJob` succeeds.
 * Audio bytes are base64-encoded so the in-memory store stays JSON-clean
 * (and so the GET /v1/audio/synthesize/:jobId poll route can return them
 * without a binary content-type negotiation).
 */
export interface TtsJobResponsePayload {
  kind: "tts";
  audio_b64: string;
  format: string;            // "mp3" | "wav" | …
  content_type: string;      // verbatim from upstream Piper, e.g. "audio/mpeg"
  byte_length: number;
  receipt: Record<string, unknown>;
  receipt_signature: string;
}

/**
 * OCR-flavoured terminal payload. Stored when a `runOcrJob` succeeds.
 * `content` is the extraction in the requested output_format (markdown/
 * html/json as text). The receipt's response_hash commits
 * sha256(canonical({content, output_format})).
 */
export interface OcrJobResponsePayload {
  kind: "ocr";
  output_format: string;     // "markdown" | "html" | "json"
  content: string;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  receipt: Record<string, unknown>;
  receipt_signature: string;
}

/**
 * Discriminated union of every job-payload shape the store can hold.
 * `kind` defaults to "chat" on the chat shape (older code paths don't
 * set it; new `runChatJob` writes can set kind: "chat" explicitly to make
 * the discriminator narrowing reliable).
 */
export type JobResponsePayload =
  | ChatJobResponsePayload
  | TtsJobResponsePayload
  | OcrJobResponsePayload;

export interface JobFailure {
  httpStatus: number;
  reason: string;
  message: string;
}

export interface JobRecord {
  jobId: string;
  escrowRef: string;
  status: JobStatus;
  createdAtMs: number;
  terminalAtMs?: number;
  responsePayload?: JobResponsePayload;
  failure?: JobFailure;
}

export type JobId = string;

/** TTL for terminal jobs before eviction (ms). */
export const JOB_TTL_MS = 600_000;

function isTerminal(status: JobStatus): boolean {
  return status === "done" || status === "failed";
}

export class JobStore {
  private readonly records = new Map<JobId, JobRecord>();

  /** create a new job record with status "accepted". Returns the jobId. */
  create(escrowRef: string): JobId {
    const jobId = globalThis.crypto.randomUUID();
    const record: JobRecord = {
      jobId,
      escrowRef,
      status: "accepted",
      createdAtMs: Date.now(),
    };
    this.records.set(jobId, record);
    return jobId;
  }

  /** Transition job from "accepted" to "running". No-op on unknown / running / terminal. */
  setRunning(jobId: JobId): void {
    const rec = this.records.get(jobId);
    if (!rec) return;
    if (rec.status !== "accepted") return;
    rec.status = "running";
  }

  /** Transition to "done" with the response payload. No-op on unknown / terminal. */
  complete(jobId: JobId, payload: JobResponsePayload): void {
    const rec = this.records.get(jobId);
    if (!rec) return;
    if (isTerminal(rec.status)) return;
    rec.status = "done";
    rec.responsePayload = payload;
    rec.terminalAtMs = Date.now();
  }

  /** Transition to "failed" with the failure details. No-op on unknown / terminal. */
  fail(jobId: JobId, failure: JobFailure): void {
    const rec = this.records.get(jobId);
    if (!rec) return;
    if (isTerminal(rec.status)) return;
    rec.status = "failed";
    rec.failure = failure;
    rec.terminalAtMs = Date.now();
  }

  /** Return the job record or null if not found. */
  get(jobId: JobId): JobRecord | null {
    return this.records.get(jobId) ?? null;
  }

  /**
   * Remove terminal jobs whose terminalAtMs is older than JOB_TTL_MS
   * relative to `now`. Strict greater-than: a record evictable at
   * exactly TTL is KEPT for one more tick (matches Caroline's pin).
   */
  evictExpired(now: number): void {
    for (const [jobId, rec] of this.records) {
      if (rec.terminalAtMs === undefined) continue;
      if (now - rec.terminalAtMs > JOB_TTL_MS) {
        this.records.delete(jobId);
      }
    }
  }

  /** Return the number of job records currently in the store. */
  count(): number {
    return this.records.size;
  }
}
