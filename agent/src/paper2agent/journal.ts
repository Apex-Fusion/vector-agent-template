import { mkdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Receipt } from "@marketplace/shared/receipt";
import type { JsonObject } from "@marketplace/shared/paper2agent";

export interface ToolJob {
  job_id: string;
  escrow_ref: string;
  manifest_hash: string;
  input: JsonObject;
  status: "accepted" | "running" | "done" | "failed";
  phase: "admitted" | "claiming" | "claimed" | "executing" | "signed" | "submitting" | "submitted";
  claimed_ref?: string;
  submitted_ref?: string;
  result?: JsonObject;
  receipt?: Receipt;
  receipt_signature?: string;
  pub_key_hex?: string;
  reason?: string;
}

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * No terminal TTL: signed evidence survives financial uncertainty and restart.
 * Memory keeps only the escrow index and records that can still change. A
 * durable terminal record is read again from its file when a caller needs it.
 */
export class ToolJournal {
  private readonly jobEscrows = new Map<string, string>();
  private readonly escrows = new Map<string, string>();
  /** Open records, and any record whose latest durable write failed. */
  private readonly live = new Map<string, ToolJob>();

  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".json") || !JOB_ID.test(name.slice(0, -5))) continue;
      const job = this.read(name.slice(0, -5));
      if (this.escrows.has(job.escrow_ref)) throw new Error("Duplicate escrow in tool journal");
      this.jobEscrows.set(job.job_id, job.escrow_ref);
      this.escrows.set(job.escrow_ref, job.job_id);
      if (job.status === "accepted" || job.status === "running") {
        this.save({ ...job, status: "failed", reason: "supplier_interrupted_financial_status_unknown" });
      }
    }
  }

  get(id: string): ToolJob | undefined {
    const escrowRef = this.jobEscrows.get(id);
    if (escrowRef === undefined) return undefined;
    const live = this.live.get(id);
    if (live) return live;
    const job = this.read(id);
    if (job.escrow_ref !== escrowRef) throw new Error("Tool journal record changed");
    return job;
  }

  /** The durable duplicate key: one job per Open escrow, for every manifest version. */
  byEscrow(ref: string): ToolJob | undefined {
    const id = this.escrows.get(ref);
    return id === undefined ? undefined : this.get(id);
  }

  hasEscrow(ref: string): boolean {
    return this.escrows.has(ref);
  }

  create(escrowRef: string, manifestHash: string, input: JsonObject): ToolJob {
    if (this.hasEscrow(escrowRef)) throw new Error("Escrow already has a tool job");
    const job: ToolJob = { job_id: randomUUID(), escrow_ref: escrowRef,
      manifest_hash: manifestHash, input, status: "accepted", phase: "admitted" };
    this.save(job);
    return job;
  }

  save(job: ToolJob): void {
    if (!JOB_ID.test(job.job_id)) throw new Error("Invalid tool job id");
    // Keep signed output in memory even when the disk fails. No transaction may
    // be sent after a failed durable write; the caller handles that failure.
    this.jobEscrows.set(job.job_id, job.escrow_ref);
    this.escrows.set(job.escrow_ref, job.job_id);
    this.live.set(job.job_id, job);
    const path = join(this.directory, `${job.job_id}.json`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(job));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      renameSync(temporary, path);
      const dir = openSync(this.directory, "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* The rename can already be durable. */ }
      throw error;
    }
    // A durable terminal record never changes again.
    if (job.status === "done" || job.status === "failed") this.live.delete(job.job_id);
  }

  /** Bounded read of one durable record. Any mismatch fails closed. */
  private read(id: string): ToolJob {
    const path = join(this.directory, `${id}.json`);
    if (statSync(path).size > 1048576) throw new Error("Tool journal record exceeds limit");
    const job = JSON.parse(readFileSync(path, "utf8")) as ToolJob;
    if (job.job_id !== id || typeof job.escrow_ref !== "string" ||
        typeof job.manifest_hash !== "string") throw new Error("Invalid tool journal record");
    return job;
  }
}
