import { Pool } from "pg";
import type { ResponseRequest } from "@marketplace/shared/responses";
import type { CapacitySnapshot } from "./capacityGate.js";
import { formatUsdNanos } from "./money.js";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS reseller_jobs (
  escrow_ref text PRIMARY KEY,
  local_job_id text,
  status text NOT NULL CHECK (status IN ('received','claimed','running','submitting','submitted','settled','failed')),
  provider text NOT NULL,
  provider_model text NOT NULL,
  marketplace_model text NOT NULL,
  request_json jsonb NOT NULL,
  response_json jsonb,
  receipt_json jsonb,
  public_preview boolean NOT NULL DEFAULT false,
  prompt_preview text,
  output_preview text,
  balance_before_nanos bigint NOT NULL,
  balance_after_nanos bigint,
  worst_case_cost_nanos bigint NOT NULL,
  actual_cost_nanos bigint,
  price_lovelace bigint NOT NULL,
  prompt_tokens integer,
  completion_tokens integer,
  claim_tx_hash text,
  submitted_ref text,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS reseller_jobs_status_idx
  ON reseller_jobs (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS reseller_jobs_created_idx
  ON reseller_jobs (created_at DESC);

CREATE TABLE IF NOT EXISTS reseller_capacity (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider text NOT NULL,
  model text NOT NULL,
  can_serve boolean NOT NULL,
  reason text NOT NULL,
  checked_at timestamptz,
  remaining_allowance_nanos bigint NOT NULL,
  reserve_nanos bigint NOT NULL,
  sellable_nanos bigint NOT NULL,
  worst_case_job_nanos bigint NOT NULL,
  available_jobs bigint,
  limit_reset text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

export interface ReceivedJob {
  escrowRef: string;
  provider: string;
  providerModel: string;
  marketplaceModel: string;
  request: ResponseRequest;
  publicPreview: boolean;
  balanceBeforeUsdNanos: bigint;
  worstCaseCostUsdNanos: bigint;
  priceLovelace: bigint;
}

export interface RecordedOutput {
  response: Record<string, unknown>;
  receipt: Record<string, unknown>;
  promptTokens: number;
  completionTokens: number;
  actualCostUsdNanos: bigint | null;
  outputText: string;
}

export interface SubmittedJobRow {
  escrowRef: string;
  submittedRef: string;
}

export interface PublicResellerJob {
  escrow_ref: string;
  status: "settled" | "failed";
  provider: string;
  provider_model: string;
  marketplace_model: string;
  prompt_preview: string | null;
  output_preview: string | null;
  upstream_cost_usd: string | null;
  ap3x_payout: string;
  claim_tx_hash: string | null;
  submitted_ref: string | null;
  failure_reason: string | null;
  created_at: string;
  settled_at: string | null;
}

export interface PublicResellerTotals {
  settled_jobs: number;
  failed_jobs: number;
  upstream_spend_usd: string;
  ap3x_earned: string;
}

export class ResellerEvidenceStore {
  private readonly pool: Pool;
  private readonly previewMaxChars: number;

  constructor(databaseUrl: string, previewMaxChars: number) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 4 });
    this.previewMaxChars = previewMaxChars;
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(9042713861245)");
      await client.query(SCHEMA_SQL);
    } finally {
      await client.query("SELECT pg_advisory_unlock(9042713861245)").catch(() => undefined);
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async markInterruptedJobs(): Promise<void> {
    await this.pool.query(
      `UPDATE reseller_jobs
       SET status = 'failed', failure_reason = 'interrupted_on_restart', updated_at = now()
       WHERE status IN ('received','claimed','running')`,
    );
  }

  async saveCapacity(snapshot: CapacitySnapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO reseller_capacity (
         singleton, provider, model, can_serve, reason, checked_at,
         remaining_allowance_nanos, reserve_nanos, sellable_nanos,
         worst_case_job_nanos, available_jobs, limit_reset, updated_at
       ) VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
       ON CONFLICT (singleton) DO UPDATE SET
         provider=EXCLUDED.provider, model=EXCLUDED.model,
         can_serve=EXCLUDED.can_serve, reason=EXCLUDED.reason,
         checked_at=EXCLUDED.checked_at,
         remaining_allowance_nanos=EXCLUDED.remaining_allowance_nanos,
         reserve_nanos=EXCLUDED.reserve_nanos,
         sellable_nanos=EXCLUDED.sellable_nanos,
         worst_case_job_nanos=EXCLUDED.worst_case_job_nanos,
         available_jobs=EXCLUDED.available_jobs,
         limit_reset=EXCLUDED.limit_reset, updated_at=now()`,
      [
        snapshot.provider,
        snapshot.model,
        snapshot.canServe,
        snapshot.reason,
        snapshot.checkedAtMs === null ? null : new Date(snapshot.checkedAtMs),
        snapshot.remainingAllowanceUsdNanos.toString(),
        snapshot.reserveUsdNanos.toString(),
        snapshot.sellableUsdNanos.toString(),
        snapshot.worstCaseJobUsdNanos.toString(),
        snapshot.availableJobs?.toString() ?? null,
        snapshot.limitReset,
      ],
    );
  }

  async recordReceived(job: ReceivedJob): Promise<void> {
    const promptPreview = job.publicPreview
      ? redactPublicPreview(JSON.stringify(job.request.input), this.previewMaxChars)
      : null;
    await this.pool.query(
      `INSERT INTO reseller_jobs (
         escrow_ref, status, provider, provider_model, marketplace_model,
         request_json, public_preview, prompt_preview, balance_before_nanos,
         worst_case_cost_nanos, price_lovelace
       ) VALUES ($1,'received',$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [
        job.escrowRef,
        job.provider,
        job.providerModel,
        job.marketplaceModel,
        JSON.stringify(job.request),
        job.publicPreview,
        promptPreview,
        job.balanceBeforeUsdNanos.toString(),
        job.worstCaseCostUsdNanos.toString(),
        job.priceLovelace.toString(),
      ],
    );
  }

  async recordClaimed(
    escrowRef: string,
    claimTxHash: string,
    localJobId: string,
  ): Promise<void> {
    await this.transition(
      escrowRef,
      ["received"],
      `status='claimed', claim_tx_hash=$2, local_job_id=$3`,
      [claimTxHash, localJobId],
    );
  }

  async recordInferenceStarted(escrowRef: string): Promise<void> {
    await this.transition(escrowRef, ["claimed"], `status='running'`, []);
  }

  async recordOutput(escrowRef: string, output: RecordedOutput): Promise<void> {
    const outputPreview = await this.publicPreviewEnabled(escrowRef)
      ? redactPublicPreview(output.outputText, this.previewMaxChars)
      : null;
    await this.transition(
      escrowRef,
      ["running"],
      `response_json=$2::jsonb, receipt_json=$3::jsonb,
       prompt_tokens=$4, completion_tokens=$5, actual_cost_nanos=$6,
       output_preview=$7`,
      [
        JSON.stringify(output.response),
        JSON.stringify(output.receipt),
        output.promptTokens,
        output.completionTokens,
        output.actualCostUsdNanos?.toString() ?? null,
        outputPreview,
      ],
      false,
    );
  }

  async recordSubmitting(escrowRef: string, submittedRef: string): Promise<void> {
    await this.transition(
      escrowRef,
      ["running"],
      `status='submitting', submitted_ref=$2`,
      [submittedRef],
    );
  }

  async recordSubmitConfirmed(escrowRef: string): Promise<void> {
    await this.transition(
      escrowRef,
      ["submitting"],
      `status='submitted'`,
      [],
    );
  }

  async recordSettled(
    escrowRef: string,
    balanceAfterUsdNanos: bigint | null,
  ): Promise<void> {
    await this.transition(
      escrowRef,
      ["submitted"],
      `status='settled', balance_after_nanos=$2, settled_at=now()`,
      [balanceAfterUsdNanos?.toString() ?? null],
    );
  }

  async recordFailed(escrowRef: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE reseller_jobs
       SET status='failed', failure_reason=$2, updated_at=now()
       WHERE escrow_ref=$1 AND status <> 'settled'`,
      [escrowRef, reason.slice(0, 1000)],
    );
  }

  async listSubmitting(): Promise<SubmittedJobRow[]> {
    const result = await this.pool.query<{
      escrow_ref: string;
      submitted_ref: string;
    }>(
      `SELECT escrow_ref, submitted_ref FROM reseller_jobs
       WHERE status='submitting' AND submitted_ref IS NOT NULL`,
    );
    return result.rows.map((row) => ({
      escrowRef: row.escrow_ref,
      submittedRef: row.submitted_ref,
    }));
  }

  async listSubmitted(): Promise<SubmittedJobRow[]> {
    const result = await this.pool.query<{
      escrow_ref: string;
      submitted_ref: string;
    }>(
      `SELECT escrow_ref, submitted_ref FROM reseller_jobs
       WHERE status='submitted' AND submitted_ref IS NOT NULL`,
    );
    return result.rows.map((row) => ({
      escrowRef: row.escrow_ref,
      submittedRef: row.submitted_ref,
    }));
  }

  async listPublicJobs(limit: number): Promise<PublicResellerJob[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.pool.query<{
      escrow_ref: string;
      status: "settled" | "failed";
      provider: string;
      provider_model: string;
      marketplace_model: string;
      prompt_preview: string | null;
      output_preview: string | null;
      actual_cost_nanos: string | null;
      price_lovelace: string;
      claim_tx_hash: string | null;
      submitted_ref: string | null;
      failure_reason: string | null;
      created_at: Date;
      settled_at: Date | null;
    }>(
      `SELECT escrow_ref,status,provider,provider_model,marketplace_model,
              prompt_preview,output_preview,actual_cost_nanos,price_lovelace,
              claim_tx_hash,submitted_ref,failure_reason,created_at,settled_at
       FROM reseller_jobs WHERE status IN ('settled','failed')
       ORDER BY created_at DESC LIMIT $1`,
      [safeLimit],
    );
    return result.rows.map((row) => ({
      escrow_ref: row.escrow_ref,
      status: row.status,
      provider: row.provider,
      provider_model: row.provider_model,
      marketplace_model: row.marketplace_model,
      prompt_preview: row.prompt_preview,
      output_preview: row.output_preview,
      upstream_cost_usd: row.actual_cost_nanos === null
        ? null
        : formatUsdNanos(BigInt(row.actual_cost_nanos)),
      ap3x_payout: row.status === "settled"
        ? formatAp3x(BigInt(row.price_lovelace))
        : "0.000000",
      claim_tx_hash: row.claim_tx_hash,
      submitted_ref: row.submitted_ref,
      failure_reason: row.failure_reason,
      created_at: row.created_at.toISOString(),
      settled_at: row.settled_at?.toISOString() ?? null,
    }));
  }

  async publicTotals(): Promise<PublicResellerTotals> {
    const result = await this.pool.query<{
      settled_jobs: string;
      failed_jobs: string;
      spend_nanos: string;
      earned_lovelace: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status='settled')::text AS settled_jobs,
         count(*) FILTER (WHERE status='failed')::text AS failed_jobs,
         coalesce(sum(actual_cost_nanos),0)::text AS spend_nanos,
         coalesce(sum(price_lovelace) FILTER (WHERE status='settled'),0)::text AS earned_lovelace
       FROM reseller_jobs`,
    );
    const row = result.rows[0];
    return {
      settled_jobs: Number(row?.settled_jobs ?? 0),
      failed_jobs: Number(row?.failed_jobs ?? 0),
      upstream_spend_usd: formatUsdNanos(BigInt(row?.spend_nanos ?? 0)),
      ap3x_earned: formatAp3x(BigInt(row?.earned_lovelace ?? 0)),
    };
  }

  private async publicPreviewEnabled(escrowRef: string): Promise<boolean> {
    const result = await this.pool.query<{ public_preview: boolean }>(
      "SELECT public_preview FROM reseller_jobs WHERE escrow_ref=$1",
      [escrowRef],
    );
    return result.rows[0]?.public_preview === true;
  }

  private async transition(
    escrowRef: string,
    expected: string[],
    assignment: string,
    values: unknown[],
    requireStatusChange = true,
  ): Promise<void> {
    const parameters = [escrowRef, ...values];
    const expectedPlaceholders = expected
      .map((_, index) => `$${parameters.length + index + 1}`)
      .join(",");
    parameters.push(...expected);
    const result = await this.pool.query(
      `UPDATE reseller_jobs SET ${assignment}, updated_at=now()
       WHERE escrow_ref=$1 AND status IN (${expectedPlaceholders})`,
      parameters,
    );
    if (result.rowCount !== 1 && requireStatusChange) {
      throw new Error(
        `invalid reseller job transition for ${escrowRef}; expected ${expected.join("|")}`,
      );
    }
    if (result.rowCount !== 1 && !requireStatusChange) {
      throw new Error(`reseller job not running: ${escrowRef}`);
    }
  }
}

export function redactPublicPreview(value: string, maxChars: number): string {
  const redacted = value
    .replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "[private material]",
    )
    .replace(
      /["']?\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|PRIV[_-]?KEY)\b["']?\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,}]+)/gi,
      "[secret assignment]",
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[jwt]")
    .replace(/\b(?:gh[opsu]_|github_pat_)[A-Za-z0-9_]{16,}\b/g, "[secret]")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "[64-hex secret]")
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, "[secret]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [secret]")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [secret]")
    .replace(/\b(?:xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}\b/g, "[secret]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatAp3x(lovelace: bigint): string {
  const whole = lovelace / 1_000_000n;
  const fraction = (lovelace % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

