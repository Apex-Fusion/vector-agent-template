import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { ResponseRequest } from "@marketplace/shared/responses";
import type { AdvertDatum } from "@marketplace/shared/cbor";
import type { SupplierState } from "../state.js";
import { CapacityGate, type CapacitySnapshot } from "./capacityGate.js";
import {
  ResellerEvidenceStore,
  type PublicResellerJob,
  type RecordedOutput,
} from "./evidenceStore.js";
import { formatUsdNanos } from "./money.js";

interface ResellerRuntimeOptions {
  chain: ChainProvider;
  state: SupplierState;
  gate: CapacityGate;
  store: ResellerEvidenceStore;
  advert: AdvertDatum;
  advertRef: OutputReference;
  providerModel: string;
  pollIntervalMs: number;
  settlementPollMs?: number;
}

export interface PublicResellerState {
  provider: string;
  provider_model: string;
  marketplace_model: string;
  advert_ref: string;
  supplier_pkh: string;
  status: "free" | "working" | "offline";
  reason: string;
  capacity: {
    remaining_allowance_usd: string;
    protected_reserve_usd: string;
    sellable_usd: string;
    committed_usd: string;
    worst_case_job_usd: string;
    available_jobs: string | null;
    checked_at: string | null;
    limit_reset: string | null;
  };
  totals: {
    settled_jobs: number;
    failed_jobs: number;
    upstream_spend_usd: string;
    ap3x_earned: string;
  };
}

export class ResellerRuntime {
  readonly maxInputTokens: number;

  private readonly chain: ChainProvider;
  private readonly state: SupplierState;
  private readonly gate: CapacityGate;
  private readonly store: ResellerEvidenceStore;
  private readonly advert: AdvertDatum;
  private readonly advertRef: OutputReference;
  private readonly providerModel: string;
  private readonly pollIntervalMs: number;
  private readonly settlementPollMs: number;
  private capacityTimer: NodeJS.Timeout | null = null;
  private readonly settlementTimers = new Map<string, NodeJS.Timeout>();
  private readonly submissionTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: ResellerRuntimeOptions & { maxInputTokens: number }) {
    this.chain = options.chain;
    this.state = options.state;
    this.gate = options.gate;
    this.store = options.store;
    this.advert = options.advert;
    this.advertRef = options.advertRef;
    this.providerModel = options.providerModel;
    this.pollIntervalMs = options.pollIntervalMs;
    this.settlementPollMs = options.settlementPollMs ?? 5_000;
    this.maxInputTokens = options.maxInputTokens;
  }

  async initialize(): Promise<void> {
    await this.store.initialize();
    await this.store.markInterruptedJobs();
    await this.refreshCapacity();
    this.capacityTimer = setInterval(() => {
      void this.refreshCapacity().catch(() => undefined);
    }, this.pollIntervalMs);
    this.capacityTimer.unref();

    for (const row of await this.store.listSubmitting()) {
      this.trackSubmissionConfirmation(row.escrowRef, row.submittedRef);
    }
    for (const row of await this.store.listSubmitted()) {
      this.trackSettlement(row.escrowRef, row.submittedRef);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.capacityTimer ?? undefined);
    this.capacityTimer = null;
    for (const timer of this.settlementTimers.values()) clearInterval(timer);
    this.settlementTimers.clear();
    for (const timer of this.submissionTimers.values()) clearInterval(timer);
    this.submissionTimers.clear();
    await this.store.close();
  }

  capacitySnapshot(): CapacitySnapshot {
    return this.gate.snapshot();
  }

  effectiveStatus(): "free" | "working" | "offline" {
    const base = this.state.snapshot().status;
    if (base === "working") return "working";
    if (base === "offline") return "offline";
    return this.gate.snapshot().canServe ? "free" : "offline";
  }

  async refreshCapacity(): Promise<CapacitySnapshot> {
    try {
      await this.store.ping();
      const snapshot = await this.gate.refresh();
      await this.store.saveCapacity(snapshot);
      return snapshot;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.gate.forceUnavailable("database_unavailable", detail);
      throw error;
    }
  }

  async recordReceived(
    escrowRef: string,
    request: ResponseRequest,
    publicPreview: boolean,
  ): Promise<void> {
    const snapshot = this.gate.snapshot();
    await this.databaseOperation(() => this.store.recordReceived({
      escrowRef,
      provider: snapshot.provider,
      providerModel: this.providerModel,
      marketplaceModel: this.advert.model,
      request,
      publicPreview,
      balanceBeforeUsdNanos: snapshot.remainingAllowanceUsdNanos,
      worstCaseCostUsdNanos: snapshot.worstCaseJobUsdNanos,
      priceLovelace: this.advert.price_lovelace,
    }));
  }

  async recordClaimed(
    escrowRef: string,
    claimTxHash: string,
    localJobId: string,
  ): Promise<void> {
    await this.databaseOperation(
      () => this.store.recordClaimed(escrowRef, claimTxHash, localJobId),
    );
  }

  async recordInferenceStarted(escrowRef: string): Promise<void> {
    await this.databaseOperation(() => this.store.recordInferenceStarted(escrowRef));
  }

  async recordOutput(
    escrowRef: string,
    output: Omit<RecordedOutput, "actualCostUsdNanos"> & {
      actualCostUsdNanos?: bigint | null;
    },
  ): Promise<void> {
    const snapshot = this.gate.snapshot();
    const calculatedCost =
      snapshot.requestPriceUsdNanos +
      snapshot.promptPriceUsdNanosPerToken * BigInt(output.promptTokens) +
      snapshot.completionPriceUsdNanosPerToken * BigInt(output.completionTokens);
    await this.databaseOperation(() => this.store.recordOutput(escrowRef, {
      ...output,
      actualCostUsdNanos: output.actualCostUsdNanos ?? calculatedCost,
    }));
  }

  async recordSubmitting(escrowRef: string, submittedRef: string): Promise<void> {
    await this.databaseOperation(
      () => this.store.recordSubmitting(escrowRef, submittedRef),
    );
  }

  async recordSubmitConfirmed(
    escrowRef: string,
    submittedRef: string,
  ): Promise<void> {
    await this.databaseOperation(
      () => this.store.recordSubmitConfirmed(escrowRef),
    );
    this.trackSettlement(escrowRef, submittedRef);
  }

  watchSubmitting(escrowRef: string, submittedRef: string): void {
    this.trackSubmissionConfirmation(escrowRef, submittedRef);
  }

  async recordFailed(escrowRef: string, reason: string): Promise<void> {
    await this.databaseOperation(() => this.store.recordFailed(escrowRef, reason));
  }

  async publicState(): Promise<PublicResellerState> {
    try {
      await this.store.ping();
      const totals = await this.store.publicTotals();
      const capacity = this.gate.snapshot();
      const base = this.state.snapshot();
      const status = this.effectiveStatus();
      const committed = base.status === "working"
        ? capacity.worstCaseJobUsdNanos
        : 0n;
      return {
        provider: capacity.provider,
        provider_model: this.providerModel,
        marketplace_model: this.advert.model,
        advert_ref: `${this.advertRef.txHash}#${this.advertRef.index}`,
        supplier_pkh: this.advert.supplier_pkh,
        status,
        reason: status === "working" ? "working" : capacity.reason,
        capacity: {
          remaining_allowance_usd: formatUsdNanos(capacity.remainingAllowanceUsdNanos),
          protected_reserve_usd: formatUsdNanos(capacity.reserveUsdNanos),
          sellable_usd: formatUsdNanos(capacity.sellableUsdNanos),
          committed_usd: formatUsdNanos(committed),
          worst_case_job_usd: formatUsdNanos(capacity.worstCaseJobUsdNanos),
          available_jobs: capacity.availableJobs?.toString() ?? null,
          checked_at: capacity.checkedAtMs === null
            ? null
            : new Date(capacity.checkedAtMs).toISOString(),
          limit_reset: capacity.limitReset,
        },
        totals,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.gate.forceUnavailable("database_unavailable", detail);
      throw error;
    }
  }

  async publicJobs(limit: number): Promise<PublicResellerJob[]> {
    try {
      return await this.store.listPublicJobs(limit);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.gate.forceUnavailable("database_unavailable", detail);
      throw error;
    }
  }


  private async databaseOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.gate.forceUnavailable("database_unavailable", detail);
      throw error;
    }
  }

  private trackSubmissionConfirmation(
    escrowRef: string,
    submittedRef: string,
  ): void {
    if (this.submissionTimers.has(escrowRef)) return;
    const ref = parseOutputReference(submittedRef);
    if (!ref) return;
    let running = false;
    const check = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const utxo = await this.chain.queryUtxo(ref);
        if (utxo === null) return;
        await this.recordSubmitConfirmed(escrowRef, submittedRef);
        clearInterval(this.submissionTimers.get(escrowRef));
        this.submissionTimers.delete(escrowRef);
      } catch {
        // A later poll retries. Provider inference is never replayed.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void check(), this.settlementPollMs);
    timer.unref();
    this.submissionTimers.set(escrowRef, timer);
    void check();
  }

  private trackSettlement(escrowRef: string, submittedRef: string): void {
    if (this.settlementTimers.has(escrowRef)) return;
    const ref = parseOutputReference(submittedRef);
    if (!ref) return;
    let running = false;
    const check = async (): Promise<void> => {
      if (running) return;
      running = true;
      try {
        const utxo = await this.chain.queryUtxo(ref);
        if (utxo !== null) return;
        await this.refreshCapacity().catch(() => this.gate.snapshot());
        const balance = this.gate.snapshot().error === null
          ? this.gate.snapshot().remainingAllowanceUsdNanos
          : null;
        await this.databaseOperation(
          () => this.store.recordSettled(escrowRef, balance),
        );
        clearInterval(this.settlementTimers.get(escrowRef));
        this.settlementTimers.delete(escrowRef);
      } catch {
        // A later poll retries chain or database recovery. Inference is never replayed.
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => void check(), this.settlementPollMs);
    timer.unref();
    this.settlementTimers.set(escrowRef, timer);
    void check();
  }
}

function parseOutputReference(value: string): OutputReference | null {
  const match = /^([0-9a-fA-F]{64})#(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  return { txHash: match[1], index: Number(match[2]) };
}
