import type { SurplusManagerConfig } from "./config.js";
import type {
  SurplusClient,
  SurplusDailyEarnings,
  SurplusEarnings,
  SurplusOffer,
  SurplusOrderBook,
  SurplusSale,
} from "./client.js";
import {
  hashSurplusSale,
  type SurplusDashboardVectorProof,
} from "./vectorProof.js";
import type {
  SurplusControllerStatus,
  SurplusSellerController,
} from "./controller.js";
import type { OpenRouterKeyClient } from "./openRouterKey.js";
import { formatUsdNanos } from "../reseller/money.js";
import { formatMicroUsd } from "./policy.js";

export interface VectorMigrationSummary {
  status: "retired";
  model: string;
  supplierWallet: string;
  advertRef: string;
  retirementTransaction: string;
  retiredOn: string;
  historicalAp3xEarned: string;
  historicalSettledJobs: number;
  historicalUpstreamSpendUsd: string;
}
export interface DashboardSaleProof {
  status: "pending" | "confirmed" | "failed";
  saleHash: string | null;
  batchRoot: string | null;
  txHash: string | null;
  leafIndex: number | null;
  siblings: string[];
}

export interface DashboardProofSource {
  dashboardProof(saleId: string): SurplusDashboardVectorProof | null;
}


export interface SurplusDashboardSnapshot {
  generatedAt: string;
  controller: SurplusControllerStatus;
  identity: {
    sellerWallet: string;
    payoutAddress: string;
  };
  provider: {
    name: "OpenRouter";
    hardLimitUsd: string;
    remainingUsd: string;
    usedUsd: string;
    reserveUsd: string;
    estimatedDailyExposureUsd: string;
  };
  surplus: {
    offer: {
      id: string | null;
      model: string | null;
      providerModel: string | null;
      status: "active" | "inactive" | "missing";
      dailyCapUsd: string | null;
      costMultiplier: number | null;
      inputUsdPer1m: string | null;
      outputUsdPer1m: string | null;
      rank: number | null;
      available: boolean;
      healthy: boolean;
      trusted: boolean;
      trades24h: number;
      volume24hUsd: string;
      capRemainingUsd: string | null;
    };
    earnings: {
      totalUsd: string;
      pendingUsd: string;
      paidUsd: string;
      requests: number;
      tokens: number;
      today: SurplusDailyEarnings | null;
      topModel: string | null;
      payoutHoldReason: string | null;
      payoutHoldReleasesAt: string | null;
    };
    recentSales: Array<{
      id: string;
      model: string;
      createdAt: string | null;
      settlementStatus: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      revenueUsd: string;
      transactionHash: string | null;
      vectorProof: DashboardSaleProof;
    }>;
  };
  vector: VectorMigrationSummary;
}

interface SurplusDashboardOptions {
  controller: Pick<SurplusSellerController, "snapshot">;
  client: Pick<SurplusClient, "listAllOffers" | "getEarnings" | "getOrderBook">;
  allowance: Pick<OpenRouterKeyClient, "readAllowance">;
  config: SurplusManagerConfig;
  vector?: VectorMigrationSummary;
  proofs?: DashboardProofSource;
  cacheMs?: number;
  now?: () => number;
}

const DEFAULT_VECTOR_MIGRATION: VectorMigrationSummary = {
  status: "retired",
  model: "deepseek/deepseek-v4-flash",
  supplierWallet: "addr1v8zy05zsugau8su0lqn8q37xlryh39cww9mw9t6g7vt207c9xfc9d",
  advertRef:
    "29bc9e7ec9f4a26f33e419436cfe95239b5d06b75db637e8dbb4cbc478d1a445#0",
  retirementTransaction:
    "d7fdae603e5744c98efc20c25d73a83ebfef0308806026a370d9f81c975c11fa",
  retiredOn: "2026-08-27",
  historicalAp3xEarned: "1.600000",
  historicalSettledJobs: 8,
  historicalUpstreamSpendUsd: "0.000093",
};

export class SurplusDashboardService {
  private readonly controller: Pick<SurplusSellerController, "snapshot">;
  private readonly client: Pick<
    SurplusClient,
    "listAllOffers" | "getEarnings" | "getOrderBook"
  >;
  private readonly allowance: Pick<OpenRouterKeyClient, "readAllowance">;
  private readonly config: SurplusManagerConfig;
  private readonly proofs: DashboardProofSource | null;
  private readonly vector: VectorMigrationSummary;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cache: { fetchedAt: number; value: SurplusDashboardSnapshot } | null = null;
  private inFlight: Promise<SurplusDashboardSnapshot> | null = null;

  constructor(options: SurplusDashboardOptions) {
    this.controller = options.controller;
    this.client = options.client;
    this.allowance = options.allowance;
    this.config = options.config;
    this.proofs = options.proofs ?? null;
    this.vector = options.vector ?? DEFAULT_VECTOR_MIGRATION;
    this.cacheMs = options.cacheMs ?? 15_000;
    this.now = options.now ?? Date.now;
  }

  async getSnapshot(): Promise<SurplusDashboardSnapshot> {
    const now = this.now();
    if (this.cache && now - this.cache.fetchedAt < this.cacheMs) {
      return this.cache.value;
    }
    if (this.inFlight) return this.inFlight;
    const load = this.loadSnapshot();
    this.inFlight = load;
    try {
      const value = await load;
      this.cache = { fetchedAt: this.now(), value };
      return value;
    } finally {
      this.inFlight = null;
    }
  }

  private async loadSnapshot(): Promise<SurplusDashboardSnapshot> {
    const controller = this.controller.snapshot();
    const [offers, earnings, allowance, orderBook] = await Promise.all([
      this.client.listAllOffers(),
      this.client.getEarnings(),
      this.allowance.readAllowance(),
      controller.model ? this.client.getOrderBook(controller.model) : null,
    ]);
    const offer = findOffer(offers, controller.offerId);
    const marketOffer = findMarketOffer(orderBook, controller.offerId);
    const usedUsdNanos = allowance.limitUsdNanos - allowance.remainingUsdNanos;
    const estimatedDailyExposure =
      Number(this.config.perOfferCapUsd) * 10_000 / this.config.recoveryBps;
    const today = earnings.daily.find((day) =>
      day.day === new Date(this.now()).toISOString().slice(0, 10)
    ) ?? null;

    return {
      generatedAt: new Date(this.now()).toISOString(),
      controller,
      identity: {
        sellerWallet: this.config.sellerWallet,
        payoutAddress: this.config.payoutAddress,
      },
      provider: {
        name: "OpenRouter",
        hardLimitUsd: formatUsdNanos(allowance.limitUsdNanos, 6),
        remainingUsd: formatUsdNanos(allowance.remainingUsdNanos, 6),
        usedUsd: formatUsdNanos(usedUsdNanos, 6),
        reserveUsd: this.config.reserveUsd,
        estimatedDailyExposureUsd: estimatedDailyExposure.toFixed(6),
      },
      surplus: {
        offer: {
          id: offer?.id ?? controller.offerId,
          model: offer?.model ?? controller.model,
          providerModel: controller.providerModelId,
          status: offer?.status ?? "missing",
          dailyCapUsd: offer?.capDailyUsd === null || offer === undefined
            ? null
            : offer.capDailyUsd.toFixed(6),
          costMultiplier: offer?.costMultiplierPpm === null || offer === undefined
            ? null
            : offer.costMultiplierPpm / 1_000_000,
          inputUsdPer1m: controller.inputUsdPer1m,
          outputUsdPer1m: controller.outputUsdPer1m,
          rank: marketOffer?.rank ?? null,
          available: marketOffer?.available ?? false,
          healthy: marketOffer?.healthy ?? false,
          trusted: marketOffer?.trusted ?? false,
          trades24h: marketOffer?.trades24h ?? 0,
          volume24hUsd: formatMicroUsd(marketOffer?.volume24hMicroUsd ?? 0),
          capRemainingUsd: marketOffer?.capRemainingMicroUsd === null ||
              marketOffer === undefined
            ? null
            : formatMicroUsd(marketOffer.capRemainingMicroUsd),
        },
        earnings: earningsSummary(earnings, today),
        recentSales: earnings.recentSales.slice(0, 25).map((sale) => ({
          id: sale.id,
          model: sale.model,
          createdAt: sale.createdAt,
          settlementStatus: sale.settlementStatus,
          inputTokens: sale.inputTokens,
          outputTokens: sale.outputTokens,
          cacheReadTokens: sale.cacheReadTokens,
          revenueUsd: formatMicroUsd(sale.sellerCostMicroUsd),
          transactionHash: sale.transactionHash,
          vectorProof: this.proofFor(sale),
        })),
      },
      vector: this.vector,
    };
  }

  private proofFor(sale: SurplusSale): DashboardSaleProof {
    const ledger = this.proofs?.dashboardProof(sale.id) ?? null;
    if (ledger !== null) return ledger;
    let saleHash: string | null = null;
    try {
      saleHash = hashSurplusSale(sale);
    } catch {
      saleHash = null;
    }
    return {
      status: "pending",
      saleHash,
      batchRoot: null,
      txHash: null,
      leafIndex: null,
      siblings: [],
    };
  }
}

function findOffer(
  offers: SurplusOffer[],
  offerId: string | null,
): SurplusOffer | undefined {
  return offerId ? offers.find((offer) => offer.id === offerId) : undefined;
}

function findMarketOffer(
  orderBook: SurplusOrderBook | null,
  offerId: string | null,
) {
  return offerId
    ? orderBook?.offers.find((offer) => offer.id === offerId)
    : undefined;
}

function earningsSummary(
  earnings: SurplusEarnings,
  today: SurplusDailyEarnings | null,
): SurplusDashboardSnapshot["surplus"]["earnings"] {
  return {
    totalUsd: formatMicroUsd(earnings.totalEarnedMicroUsd),
    pendingUsd: formatMicroUsd(earnings.pendingMicroUsd),
    paidUsd: formatMicroUsd(earnings.paidMicroUsd),
    requests: earnings.requestCount,
    tokens: earnings.tokenCount,
    today,
    topModel: earnings.topModel,
    payoutHoldReason: earnings.payoutHoldReason,
    payoutHoldReleasesAt: earnings.payoutHoldReleasesAt,
  };
}
