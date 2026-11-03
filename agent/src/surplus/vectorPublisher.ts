/**
 * vectorPublisher.ts — anchors Surplus sale Merkle batches on Vector.
 *
 * Policy (2026-08-28): every settled Base USDC settlement transaction gets its
 * own Vector counterpart. Sales are grouped by their Base `tx_hash`; each group
 * becomes one Merkle batch anchored in one label-674 Vector transaction.
 * Observed sales that fell out of the Surplus API window before settling are
 * anchored together in a trailing catch-up batch so no captured sale is left
 * without a proof.
 *
 * The publisher is fail-closed:
 * - it never anchors while the wallet cannot cover reserve + fee budget,
 * - every batch is persisted as a pending intent before any submission,
 * - a stale pending intent found at cycle start is failed as "submit" and
 *   rebuilt deterministically (same sales ⇒ same root) on the same cycle.
 */

import type { SurplusEarnings, SurplusSale } from "./client.js";
import {
  SURPLUS_SALE_PROOF_PROTOCOL,
  SURPLUS_VECTOR_BATCH_SIZE,
  type CanonicalSurplusSale,
  type FileSurplusVectorProofLedger,
  type SurplusPendingBatchIntent,
} from "./vectorProof.js";

export interface SurplusProofAnchorMetadata {
  p: typeof SURPLUS_SALE_PROOF_PROTOCOL;
  root: string;
  count: number;
  first: string;
  last: string;
}

export type SurplusProofLedgerSeam = Pick<
  FileSurplusVectorProofLedger,
  | "ingestSales"
  | "selectUnprovedSales"
  | "persistPendingBatch"
  | "pendingBatchIntent"
  | "confirmPendingBatch"
  | "failPendingBatch"
  | "dashboardProof"
>;

export interface SurplusVectorProofPublisherOptions {
  ledger: SurplusProofLedgerSeam;
  earnings: () => Promise<SurplusEarnings>;
  /**
   * Optional support-export source for sales the live window can no longer
   * show. Observed sales win on id collisions; ids already in the ledger are
   * never re-ingested, so a later live observation cannot conflict.
   */
  historicalSales?: () => Promise<readonly SurplusSale[]>;
  anchor: (
    metadata: SurplusProofAnchorMetadata,
  ) => Promise<{ expectedTxHash: string }>;
  awaitTx: (txHash: string, timeoutMs: number) => Promise<void>;
  balanceLovelace: () => Promise<bigint>;
  reserveLovelace: bigint;
  feeBudgetLovelace: bigint;
  settledStatuses: readonly string[];
  intervalMs: number;
  confirmTimeoutMs: number;
  log: (message: string) => void;
}

export interface SurplusPublisherCycleResult {
  ingested: number;
  anchored: number;
  fundingBlocked: boolean;
  failed: boolean;
}

export class SurplusVectorProofPublisher {
  private readonly options: SurplusVectorProofPublisherOptions;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<SurplusPublisherCycleResult> | null = null;
  private stopped = false;

  constructor(options: SurplusVectorProofPublisherOptions) {
    if (options.reserveLovelace < 0n || options.feeBudgetLovelace <= 0n) {
      throw new Error(
        "Surplus proof publisher needs a non-negative reserve and a positive fee budget",
      );
    }
    this.options = options;
  }

  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  private async tick(): Promise<void> {
    if (this.inFlight !== null || this.stopped) return;
    const cycle = this.runCycle();
    this.inFlight = cycle;
    try {
      await cycle;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.log(`surplus-proof: cycle failed: ${detail}`);
    } finally {
      this.inFlight = null;
    }
  }

  async runCycle(): Promise<SurplusPublisherCycleResult> {
    const { ledger, log } = this.options;
    const result: SurplusPublisherCycleResult = {
      ingested: 0,
      anchored: 0,
      fundingBlocked: false,
      failed: false,
    };

    const settled = await this.observeSettledSales();
    const historical = this.options.historicalSales === undefined
      ? []
      : await this.options.historicalSales();
    const candidates = dedupeById([...settled, ...historical]);
    const fresh = candidates.filter((sale) =>
      ledger.dashboardProof(sale.id) === null
    );
    const { inserted } = await ledger.ingestSales(fresh);
    result.ingested = inserted;
    if (inserted > 0) {
      log(`surplus-proof: captured ${inserted} newly settled sale(s)`);
    }

    const stale = ledger.pendingBatchIntent();
    if (stale !== null) {
      await ledger.failPendingBatch(stale.batchRoot, "submit");
      log(
        `surplus-proof: failed stale pending batch ${stale.batchRoot} from an interrupted run; retrying this cycle`,
      );
    }

    for (const batch of this.planBatches(candidates, ledger.selectUnprovedSales())) {
      if (this.stopped) break;
      if (!(await this.fundsAvailable())) {
        result.fundingBlocked = true;
        break;
      }
      const anchored = await this.anchorBatch(batch);
      if (!anchored) {
        result.failed = true;
        break;
      }
      result.anchored += 1;
    }
    return result;
  }

  /** Settled = carries a Base settlement tx hash and passes the status filter. */
  private async observeSettledSales(): Promise<SurplusSale[]> {
    const { earnings, settledStatuses } = this.options;
    const snapshot = await earnings();
    return snapshot.recentSales.filter((sale) =>
      sale.transactionHash !== null &&
      (settledStatuses.length === 0 ||
        settledStatuses.includes(sale.settlementStatus))
    );
  }

  /**
   * One batch per known Base settlement tx (oldest first), then catch-up
   * batches for unproved sales with no known settlement tx, chunked to the
   * ledger batch-size limit.
   */
  private planBatches(
    settled: readonly SurplusSale[],
    unproved: readonly CanonicalSurplusSale[],
  ): CanonicalSurplusSale[][] {
    const txBySaleId = new Map<string, string>();
    for (const sale of settled) {
      if (sale.transactionHash !== null) {
        txBySaleId.set(sale.id, sale.transactionHash);
      }
    }

    const groups = new Map<string, CanonicalSurplusSale[]>();
    const leftovers: CanonicalSurplusSale[] = [];
    for (const sale of unproved) {
      const settlementTx = txBySaleId.get(sale.saleId);
      if (settlementTx === undefined) {
        leftovers.push(sale);
        continue;
      }
      const group = groups.get(settlementTx);
      if (group === undefined) groups.set(settlementTx, [sale]);
      else group.push(sale);
    }

    const batches = [...groups.values()].sort(
      (left, right) => earliest(left) - earliest(right),
    );
    for (let start = 0; start < leftovers.length; start += SURPLUS_VECTOR_BATCH_SIZE) {
      batches.push(leftovers.slice(start, start + SURPLUS_VECTOR_BATCH_SIZE));
    }
    return batches;
  }

  private async fundsAvailable(): Promise<boolean> {
    const { balanceLovelace, reserveLovelace, feeBudgetLovelace, log } =
      this.options;
    const balance = await balanceLovelace();
    if (balance >= reserveLovelace + feeBudgetLovelace) return true;
    log(
      `surplus-proof: funding required — wallet holds ${balance} lovelace, ` +
        `needs reserve ${reserveLovelace} + fee budget ${feeBudgetLovelace}; anchoring paused`,
    );
    return false;
  }

  private async anchorBatch(
    sales: readonly CanonicalSurplusSale[],
  ): Promise<boolean> {
    const { ledger, anchor, awaitTx, confirmTimeoutMs, log } = this.options;
    const saleIds = sales.map((sale) => sale.saleId).sort();
    const intent: SurplusPendingBatchIntent = await ledger.persistPendingBatch(
      saleIds,
    );

    let expectedTxHash: string;
    try {
      const built = await anchor({
        p: SURPLUS_SALE_PROOF_PROTOCOL,
        root: intent.batchRoot,
        count: intent.count,
        first: intent.firstSaleId,
        last: intent.lastSaleId,
      });
      expectedTxHash = built.expectedTxHash;
    } catch (error) {
      await ledger.failPendingBatch(intent.batchRoot, "submit");
      const detail = error instanceof Error ? error.message : String(error);
      log(
        `surplus-proof: submit failed for batch ${intent.batchRoot} (${intent.count} sale(s)): ${detail}`,
      );
      return false;
    }

    try {
      await awaitTx(expectedTxHash, confirmTimeoutMs);
    } catch (error) {
      await ledger.failPendingBatch(intent.batchRoot, "confirm");
      const detail = error instanceof Error ? error.message : String(error);
      log(
        `surplus-proof: confirmation timed out for batch ${intent.batchRoot} in tx ${expectedTxHash}: ${detail}`,
      );
      return false;
    }

    await ledger.confirmPendingBatch(intent.batchRoot, expectedTxHash);
    log(
      `surplus-proof: anchored ${intent.count} sale(s) [${intent.firstSaleId}..${intent.lastSaleId}] ` +
        `root ${intent.batchRoot} in Vector tx ${expectedTxHash}`,
    );
    return true;
  }
}

function earliest(sales: readonly CanonicalSurplusSale[]): number {
  let value = Number.POSITIVE_INFINITY;
  for (const sale of sales) {
    if (sale.createdAtEpochMs < value) value = sale.createdAtEpochMs;
  }
  return value;
}

/** First occurrence wins; callers put observed live sales before export rows. */
function dedupeById(sales: readonly SurplusSale[]): SurplusSale[] {
  const seen = new Set<string>();
  const unique: SurplusSale[] = [];
  for (const sale of sales) {
    if (seen.has(sale.id)) continue;
    seen.add(sale.id);
    unique.push(sale);
  }
  return unique;
}
