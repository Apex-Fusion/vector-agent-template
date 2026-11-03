import { randomUUID } from "node:crypto";
import { parseUsdDecimal, formatUsdNanos } from "../reseller/money.js";
import type { SurplusManagerConfig } from "./config.js";
import {
  SurplusClient,
  SurplusHttpError,
  type SurplusDiscoveredModel,
  type SurplusEarnings,
  type SurplusOffer,
} from "./client.js";
import type {
  OpenRouterKeyAllowance,
  OpenRouterKeyClient,
} from "./openRouterKey.js";
import {
  formatMicroUsd,
  quoteSurplusMultiplier,
} from "./policy.js";
import {
  eligibleCompetitors,
  selectSurplusModelCandidates,
} from "./selection.js";
import type {
  SurplusControllerState,
  SurplusOfferIntent,
  SurplusStateStore,
} from "./state.js";

export type SurplusControllerClient = Pick<
  SurplusClient,
  | "listAllOffers"
  | "discoverModels"
  | "getMarkets"
  | "getOrderBook"
  | "testConnection"
  | "createOffer"
  | "updateOffer"
  | "pauseOffer"
  | "resumeOffer"
  | "getEarnings"
>;

export type OpenRouterAllowanceReader = Pick<OpenRouterKeyClient, "readAllowance">;

export interface SurplusControllerStatus {
  ok: boolean;
  phase: SurplusControllerState["phase"] | "error" | "planned" | "suspended";
  live: boolean;
  model: string | null;
  providerModelId: string | null;
  offerId: string | null;
  inputUsdPer1m: string | null;
  outputUsdPer1m: string | null;
  competitorId: string | null;
  remainingAllowanceUsd: string | null;
  reserveThresholdUsd: string;
  totalEarnedUsd: string | null;
  lastCycleAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
}

interface SurplusControllerOptions {
  config: SurplusManagerConfig;
  client: SurplusControllerClient;
  allowance: OpenRouterAllowanceReader;
  stateStore: SurplusStateStore;
  now?: () => number;
  mutationId?: () => string;
  log?: (message: string) => void;
}


export class SurplusSellerController {
  private readonly config: SurplusManagerConfig;
  private readonly client: SurplusControllerClient;
  private readonly allowance: OpenRouterAllowanceReader;
  private readonly stateStore: SurplusStateStore;
  private readonly now: () => number;
  private readonly mutationId: () => string;
  private readonly log: (message: string) => void;
  private state: SurplusControllerState | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private status: SurplusControllerStatus;

  constructor(options: SurplusControllerOptions) {
    this.config = options.config;
    this.client = options.client;
    this.allowance = options.allowance;
    this.stateStore = options.stateStore;
    this.now = options.now ?? Date.now;
    this.mutationId = options.mutationId ?? randomUUID;
    this.log = options.log ?? (() => undefined);
    const perOfferCap = parseUsdDecimal(this.config.perOfferCapUsd, "ceil");
    const aggregateCap = parseUsdDecimal(this.config.aggregateCapUsd, "floor");
    if (perOfferCap > aggregateCap) {
      throw new Error("Surplus per-offer cap must not exceed the aggregate cap");
    }
    this.status = {
      ok: false,
      phase: "selecting",
      live: this.config.live,
      model: null,
      providerModelId: null,
      offerId: null,
      inputUsdPer1m: null,
      outputUsdPer1m: null,
      competitorId: null,
      remainingAllowanceUsd: null,
      reserveThresholdUsd: this.config.reserveUsd,
      totalEarnedUsd: null,
      lastCycleAt: null,
      lastSuccessAt: null,
      lastError: null,
    };
  }

  snapshot(): SurplusControllerStatus {
    return { ...this.status };
  }

  healthy(): boolean {
    if (this.state?.phase === "completed") return true;
    if (!this.status.ok || this.status.lastSuccessAt === null) return false;
    const freshnessLimit =
      this.config.pollIntervalMs + this.config.requestTimeoutMs + 60_000;
    return this.now() - Date.parse(this.status.lastSuccessAt) <= freshnessLimit;
  }

  async start(): Promise<void> {
    if (this.state !== null) return;
    this.state = await this.stateStore.load();
    await this.runOnce();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer ?? undefined);
    this.timer = null;
    if (this.inFlight) await this.inFlight;
  }

  async runOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const cycle = this.performCycle();
    this.inFlight = cycle;
    try {
      await cycle;
    } finally {
      this.inFlight = null;
    }
  }

  private schedule(): void {
    if (this.stopped || this.state?.phase === "completed") return;
    this.timer = setTimeout(() => {
      void this.runOnce().finally(() => this.schedule());
    }, this.config.pollIntervalMs);
    this.timer.unref();
  }

  private async performCycle(): Promise<void> {
    if (this.state === null) this.state = await this.stateStore.load();
    const cycleAt = new Date(this.now()).toISOString();
    this.status = { ...this.status, lastCycleAt: cycleAt };
    if (this.state.phase === "completed") {
      this.markSuccess("completed", null, null);
      return;
    }
    try {
      if (this.state.phase === "selecting") await this.selectAndCreate();
      else if (this.state.phase === "create_pending") await this.adoptPendingCreate();
      else if (this.state.phase === "active") await this.manageActiveOffer();
      else if (this.state.phase === "stopping") await this.finishStopping();
      else await this.awaitSettlement();
    } catch (error) {
      const stateAtFailure = this.state;
      let paused = false;
      if (
        this.config.live &&
        stateAtFailure !== null &&
        "offerId" in stateAtFailure
      ) {
        try {
          await this.client.pauseOffer(stateAtFailure.offerId, this.mutationId());
          paused = true;
        } catch {
          paused = false;
        }
      }
      const detail = this.safeError(error);
      this.status = {
        ...this.status,
        ok: false,
        phase: "error",
        lastError: paused ? `${detail}; managed offer paused` : detail,
      };
      this.log(`Surplus cycle failed: ${this.status.lastError}`);
    }
  }

  private async selectAndCreate(): Promise<void> {
    const offers = await this.client.listAllOffers();
    const active = offers.filter((offer) => offer.status === "active");
    if (active.length > 0) {
      await this.pauseOffers(active);
      this.markSuccess("suspended", null, null);
      return;
    }

    const allowance = await this.allowance.readAllowance();
    this.assertAllowance(
      allowance,
      this.providerExposureUsdNanos(
        parseUsdDecimal(this.config.aggregateCapUsd, "ceil"),
      ),
    );
    const [discovered, markets] = await Promise.all([
      this.client.discoverModels(
        this.config.providerApiKey,
        this.config.providerBaseUrl,
      ),
      this.client.getMarkets(),
    ]);
    const candidates = selectSurplusModelCandidates(
      discovered,
      markets,
      this.config.recoveryBps,
      this.config.undercutBps,
    );
    const ownOfferIds = new Set(offers.map((offer) => offer.id));
    let intent: SurplusOfferIntent | null = null;
    let competitorId: string | null = null;
    for (const candidate of candidates.slice(0, this.config.maxCandidateOrderBooks)) {
      const book = await this.client.getOrderBook(candidate.model);
      const competitors = eligibleCompetitors(
        book.offers,
        this.config.sellerWallet,
        ownOfferIds,
      );
      const quote = quoteSurplusMultiplier({
        upstreamInputMicroUsdPer1m: candidate.upstreamInputMicroUsdPer1m,
        upstreamOutputMicroUsdPer1m: candidate.upstreamOutputMicroUsdPer1m,
        recoveryBps: this.config.recoveryBps,
        undercutBps: this.config.undercutBps,
        competitors,
      });
      if (!quote.competitive) continue;
      try {
        await this.client.testConnection(
          this.config.providerApiKey,
          this.config.providerBaseUrl,
          candidate.model,
        );
      } catch (error) {
        this.log(
          `Surplus candidate probe failed model=${candidate.model}: ${this.safeError(error)}`,
        );
        continue;
      }
      intent = {
        model: candidate.model,
        providerModelId: candidate.providerModelId,
        costMultiplierPpm: quote.costMultiplierPpm,
        inputMicroUsdPer1m: quote.inputMicroUsdPer1m,
        outputMicroUsdPer1m: quote.outputMicroUsdPer1m,
        baselineRemainingUsdNanos: allowance.remainingUsdNanos.toString(),
        dailyCapUsd: Number(this.config.perOfferCapUsd),
        idempotencyKey: this.mutationId(),
        createdAt: new Date(this.now()).toISOString(),
        baselineTrades24h: 0,
      };
      competitorId = quote.competitorId;
      break;
    }
    if (intent === null) {
      throw new Error("No supported OpenRouter model has a safe competitive quote");
    }
    if (!this.config.live) {
      this.markSuccess("planned", allowance, {
        intent,
        offerId: null,
        competitorId,
        totalEarnedMicroUsd: null,
      });
      return;
    }

    const pending: SurplusControllerState = {
      version: 1,
      phase: "create_pending",
      intent,
    };
    await this.stateStore.save(pending);
    this.state = pending;
    let createdOfferId: string | null = null;
    let postCreateActive: SurplusOffer[] = [];
    try {
      createdOfferId = await this.client.createOffer({
        model: intent.model,
        apiKey: this.config.providerApiKey,
        sellerBaseUrl: this.config.providerBaseUrl,
        costMultiplier: intent.costMultiplierPpm / 1_000_000,
        dailyCapUsd: intent.dailyCapUsd,
        payoutAddress: this.config.payoutAddress,
        idempotencyKey: intent.idempotencyKey,
      });
      const postCreateOffers = await this.client.listAllOffers();
      postCreateActive = postCreateOffers.filter(
        (offer) => offer.status === "active",
      );
      const created = postCreateActive.find(
        (offer) => offer.id === createdOfferId,
      );
      if (
        !created ||
        created.model !== intent.model ||
        postCreateActive.length !== 1
      ) {
        throw new Error(
          "Surplus create verification did not find exactly one expected active offer",
        );
      }
      this.assertAggregateCap(postCreateOffers);
      const activeState: SurplusControllerState = {
        version: 1,
        phase: "active",
        offerId: createdOfferId,
        intent,
        highestTrades24h: 0,
      };
      await this.stateStore.save(activeState);
      this.state = activeState;
      this.markSuccess("active", allowance, {
        intent,
        offerId: createdOfferId,
        competitorId,
        totalEarnedMicroUsd: null,
      });
    } catch (error) {
      if (createdOfferId !== null) {
        const ids = new Set(postCreateActive.map((offer) => offer.id));
        ids.add(createdOfferId);
        for (const id of ids) {
          await this.client.pauseOffer(id, this.mutationId()).catch(() => undefined);
        }
      }
      if (error instanceof SurplusHttpError && !error.ambiguousMutation) {
        const selecting: SurplusControllerState = {
          version: 1,
          phase: "selecting",
        };
        await this.stateStore.save(selecting);
        this.state = selecting;
      }
      throw error;
    }
  }

  private async adoptPendingCreate(): Promise<void> {
    if (this.state?.phase !== "create_pending") return;
    const pending = this.state;
    const offers = await this.client.listAllOffers();
    const active = offers.filter((offer) => offer.status === "active");
    const activeMatches = active
      .filter((offer) =>
        offer.model === pending.intent.model &&
        normalizeUrl(offer.sellerBaseUrl) ===
          normalizeUrl(this.config.providerBaseUrl)
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const inactiveMatches = offers
      .filter((offer) =>
        offer.status === "inactive" &&
        offer.model === pending.intent.model &&
        normalizeUrl(offer.sellerBaseUrl) ===
          normalizeUrl(this.config.providerBaseUrl)
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const primary = activeMatches[0] ?? inactiveMatches[0];
    if (!primary) {
      if (active.length > 0) await this.pauseOffers(active);
      throw new Error(
        "Create result is ambiguous and no matching offer is visible; refusing another POST",
      );
    }
    await this.pauseOffers(active.filter((offer) => offer.id !== primary.id));
    const confirmedOffers = await this.client.listAllOffers();
    const confirmedActive = confirmedOffers.filter(
      (offer) => offer.status === "active",
    );
    const expectedActive = primary.status === "active" ? 1 : 0;
    if (
      confirmedActive.length !== expectedActive ||
      (expectedActive === 1 && confirmedActive[0].id !== primary.id)
    ) {
      await this.pauseOffers(confirmedActive);
      throw new Error("Adopted Surplus create did not reconcile safely");
    }
    const adopted: SurplusControllerState = {
      version: 1,
      phase: "active",
      offerId: primary.id,
      intent: pending.intent,
      highestTrades24h: pending.intent.baselineTrades24h,
    };
    try {
      this.assertAggregateCap(confirmedOffers);
      await this.stateStore.save(adopted);
    } catch (error) {
      await this.pauseOffers(confirmedActive).catch(() => undefined);
      throw error;
    }
    this.state = adopted;
    if (primary.status === "inactive") {
      await this.manageActiveOffer();
      return;
    }
    this.markSuccess("active", null, {
      intent: adopted.intent,
      offerId: adopted.offerId,
      competitorId: null,
      totalEarnedMicroUsd: null,
    });
  }

  private async manageActiveOffer(): Promise<void> {
    if (this.state?.phase !== "active") return;
    const currentState = this.state;
    const offers = await this.client.listAllOffers();
    const activeOffers = offers.filter((offer) => offer.status === "active");
    const managed = offers.find((offer) => offer.id === currentState.offerId);
    if (!managed) {
      await this.pauseOffers(activeOffers);
      throw new Error(`Managed Surplus offer is missing: ${currentState.offerId}`);
    }
    const otherActive = activeOffers.filter(
      (offer) => offer.id !== currentState.offerId,
    );
    if (otherActive.length > 0) {
      await this.pauseOffers(otherActive);
      this.markSuccess("suspended", null, null);
      return;
    }
    this.assertAggregateCap(offers);
    const allowance = await this.allowance.readAllowance();
    this.assertAllowance(
      allowance,
      this.providerExposureUsdNanos(
        parseUsdDecimal(this.config.perOfferCapUsd, "ceil"),
      ),
    );
    const baselineAllowance = BigInt(
      currentState.intent.baselineRemainingUsdNanos,
    );
    const providerSpend = baselineAllowance > allowance.remainingUsdNanos
      ? baselineAllowance - allowance.remainingUsdNanos
      : 0n;
    const spendCap = this.providerExposureUsdNanos(
      parseUsdDecimal(this.config.perOfferCapUsd, "ceil"),
    );
    if (this.config.stopAfterTrades > 0 && providerSpend >= spendCap) {
      const stopping: SurplusControllerState = {
        version: 1,
        phase: "stopping",
        offerId: currentState.offerId,
        intent: currentState.intent,
        highestTrades24h: currentState.highestTrades24h,
        tradeObservedAt: currentState.intent.createdAt,
        pauseIdempotencyKey: this.mutationId(),
      };
      await this.stateStore.save(stopping);
      this.state = stopping;
      await this.finishStopping();
      return;
    }
    const discovered = await this.client.discoverModels(
      this.config.providerApiKey,
      this.config.providerBaseUrl,
    );
    const selected = this.requireSelectedDiscovery(discovered, currentState.intent);
    const book = await this.client.getOrderBook(currentState.intent.model);
    const ownBookOffer = book.offers.find((offer) => offer.id === currentState.offerId);
    if (
      this.config.stopAfterTrades > 0 &&
      ownBookOffer &&
      ownBookOffer.trades24h >=
        currentState.highestTrades24h + this.config.stopAfterTrades
    ) {
      const stopping: SurplusControllerState = {
        version: 1,
        phase: "stopping",
        offerId: currentState.offerId,
        intent: currentState.intent,
        highestTrades24h: ownBookOffer.trades24h,
        tradeObservedAt: new Date(this.now()).toISOString(),
        pauseIdempotencyKey: this.mutationId(),
      };
      await this.stateStore.save(stopping);
      this.state = stopping;
      await this.finishStopping();
      return;
    }

    const ownIds = new Set(offers.map((offer) => offer.id));
    const competitors = eligibleCompetitors(
      book.offers,
      this.config.sellerWallet,
      ownIds,
    );
    const quote = quoteSurplusMultiplier({
      upstreamInputMicroUsdPer1m: Math.ceil(selected.inputUsdPer1m * 1_000_000),
      upstreamOutputMicroUsdPer1m: Math.ceil(selected.outputUsdPer1m * 1_000_000),
      recoveryBps: this.config.recoveryBps,
      undercutBps: this.config.undercutBps,
      competitors,
    });
    const nextIntent: SurplusOfferIntent = {
      ...currentState.intent,
      costMultiplierPpm: quote.costMultiplierPpm,
      inputMicroUsdPer1m: quote.inputMicroUsdPer1m,
      outputMicroUsdPer1m: quote.outputMicroUsdPer1m,
    };
    const priceChanged =
      managed.costMultiplierPpm === null ||
      Math.abs(managed.costMultiplierPpm - quote.costMultiplierPpm) > 1 ||
      managed.capDailyUsd !== Number(this.config.perOfferCapUsd);
    if (this.config.live && priceChanged) {
      await this.client.updateOffer(currentState.offerId, {
        costMultiplier: quote.costMultiplier,
        dailyCapUsd: Number(this.config.perOfferCapUsd),
        idempotencyKey: this.mutationId(),
      });
    }
    if (this.config.live && managed.status === "inactive") {
      await this.client.resumeOffer(currentState.offerId, this.mutationId());
    }
    const activeState: SurplusControllerState = {
      ...currentState,
      intent: nextIntent,
      highestTrades24h: ownBookOffer?.trades24h ?? currentState.highestTrades24h,
    };
    await this.stateStore.save(activeState);
    this.state = activeState;
    const earnings = await this.client.getEarnings();
    this.markSuccess("active", allowance, {
      intent: nextIntent,
      offerId: currentState.offerId,
      competitorId: quote.competitorId,
      totalEarnedMicroUsd: earnings.totalEarnedMicroUsd,
    });
  }

  private async finishStopping(): Promise<void> {
    if (this.state?.phase !== "stopping") return;
    const stopping = this.state;
    const before = await this.client.listAllOffers();
    const active = before.filter((offer) => offer.status === "active");
    for (const offer of active) {
      const key = offer.id === stopping.offerId
        ? stopping.pauseIdempotencyKey
        : this.mutationId();
      await this.client.pauseOffer(offer.id, key);
    }
    const after = await this.client.listAllOffers();
    if (after.some((offer) => offer.status === "active")) {
      throw new Error("Surplus proof stop could not confirm all offers inactive");
    }
    const awaiting: SurplusControllerState = {
      version: 1,
      phase: "awaiting_settlement",
      offerId: stopping.offerId,
      intent: stopping.intent,
      tradeObservedAt: stopping.tradeObservedAt,
    };
    await this.stateStore.save(awaiting);
    this.state = awaiting;
    await this.awaitSettlement();
  }

  private async awaitSettlement(): Promise<void> {
    if (this.state?.phase !== "awaiting_settlement") return;
    const awaiting = this.state;
    const offers = await this.client.listAllOffers();
    const active = offers.filter((offer) => offer.status === "active");
    if (active.length > 0) {
      await this.pauseOffers(active);
      this.markSuccess("suspended", null, null);
      return;
    }
    const earnings = await this.client.getEarnings();
    const sale = this.findSettledSale(earnings, awaiting);
    if (!sale) {
      this.markSuccess("awaiting_settlement", null, {
        intent: awaiting.intent,
        offerId: awaiting.offerId,
        competitorId: null,
        totalEarnedMicroUsd: earnings.totalEarnedMicroUsd,
      });
      return;
    }
    const completed: SurplusControllerState = {
      version: 1,
      phase: "completed",
      offerId: awaiting.offerId,
      model: awaiting.intent.model,
      providerModelId: awaiting.intent.providerModelId,
      tradeObservedAt: awaiting.tradeObservedAt,
      completedAt: new Date(this.now()).toISOString(),
      settlement: {
        offerId: sale.offerId,
        createdAt: sale.createdAt ?? awaiting.tradeObservedAt,
        sellerCostMicroUsd: sale.sellerCostMicroUsd,
        settlementStatus: sale.settlementStatus,
      },
    };
    await this.stateStore.save(completed);
    this.state = completed;
    this.markSuccess("completed", null, {
      intent: awaiting.intent,
      offerId: awaiting.offerId,
      competitorId: null,
      totalEarnedMicroUsd: earnings.totalEarnedMicroUsd,
    });
  }

  private findSettledSale(
    earnings: SurplusEarnings,
    state: Extract<SurplusControllerState, { phase: "awaiting_settlement" }>,
  ): SurplusEarnings["recentSales"][number] | null {
    const tradeObservedAt = Date.parse(state.tradeObservedAt);
    return earnings.recentSales.find((sale) => {
      if (
        !this.config.settledStatuses.includes(
          sale.settlementStatus.toLowerCase(),
        )
      ) {
        return false;
      }
      if (
        sale.offerId !== state.offerId ||
        sale.createdAt === null ||
        sale.model !== state.intent.model ||
        sale.sellerCostMicroUsd <= 0
      ) {
        return false;
      }
      return Date.parse(sale.createdAt) >= tradeObservedAt;
    }) ?? null;
  }

  private requireSelectedDiscovery(
    discovered: SurplusDiscoveredModel[],
    intent: SurplusOfferIntent,
  ): SurplusDiscoveredModel {
    const selected = discovered.find((model) =>
      model.model === intent.model && model.providerModelId === intent.providerModelId
    );
    if (
      !selected ||
      !selected.supported ||
      selected.availabilityStatus !== "available" ||
      selected.modelType !== "text" ||
      selected.priceUnit !== "M" ||
      selected.priceVariable ||
      selected.inputUsdPer1m <= 0 ||
      selected.outputUsdPer1m <= 0
    ) {
      throw new Error(`Selected OpenRouter model is no longer safely sellable: ${intent.model}`);
    }
    return selected;
  }

  private assertAggregateCap(offers: SurplusOffer[]): void {
    let activeCap = 0n;
    for (const offer of offers) {
      if (offer.status !== "active") continue;
      if (offer.capDailyUsd === null) {
        throw new Error(`Active Surplus offer has no daily cap: ${offer.id}`);
      }
      const capMicroUsd = offer.capDailyUsd * 1_000_000;
      if (!Number.isSafeInteger(capMicroUsd)) {
        throw new Error(`Active Surplus offer cap has excess precision: ${offer.id}`);
      }
      activeCap += BigInt(capMicroUsd) * 1_000n;
    }
    const aggregateCap = parseUsdDecimal(this.config.aggregateCapUsd, "floor");
    if (activeCap > aggregateCap) {
      throw new Error("Active Surplus offer caps exceed the aggregate cap");
    }
  }

  private providerExposureUsdNanos(sellerCapUsdNanos: bigint): bigint {
    const numerator = sellerCapUsdNanos * 10_000n;
    const denominator = BigInt(this.config.recoveryBps);
    return (numerator + denominator - 1n) / denominator;
  }

  private assertAllowance(
    allowance: OpenRouterKeyAllowance,
    exposureUsdNanos: bigint,
  ): void {
    const reserve = parseUsdDecimal(this.config.reserveUsd, "ceil");
    const maxLimit = parseUsdDecimal(this.config.maxProviderLimitUsd, "floor");
    if (
      allowance.limitUsdNanos > maxLimit ||
      allowance.remainingUsdNanos > allowance.limitUsdNanos
    ) {
      throw new Error("OpenRouter key limit exceeds the configured containment limit");
    }
    if (allowance.remainingUsdNanos < reserve + exposureUsdNanos) {
      throw new Error("OpenRouter allowance cannot cover reserve threshold plus exposure");
    }
  }

  private async pauseOffers(offers: SurplusOffer[]): Promise<void> {
    if (!this.config.live) return;
    for (const offer of offers) {
      await this.client.pauseOffer(offer.id, this.mutationId());
    }
  }


  private safeError(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error);
    return detail
      .replaceAll(this.config.sellerApiKey, "[redacted]")
      .replaceAll(this.config.providerApiKey, "[redacted]")
      .replace(/(?:si_seller_|sk-or-v1-)[A-Za-z0-9_-]+/g, "[redacted]")
      .slice(0, 500);
  }

  private markSuccess(
    phase: SurplusControllerStatus["phase"],
    allowance: OpenRouterKeyAllowance | null,
    details: {
      intent: SurplusOfferIntent;
      offerId: string | null;
      competitorId: string | null;
      totalEarnedMicroUsd: number | null;
    } | null,
  ): void {
    const successAt = new Date(this.now()).toISOString();
    const state = this.state;
    const stateModel = state && "intent" in state
      ? state.intent.model
      : state?.phase === "completed"
        ? state.model
        : null;
    const stateProviderModel = state && "intent" in state
      ? state.intent.providerModelId
      : state?.phase === "completed"
        ? state.providerModelId
        : null;
    const stateOfferId = state && "offerId" in state ? state.offerId : null;
    this.status = {
      ...this.status,
      ok: true,
      phase,
      model: details?.intent.model ?? stateModel,
      providerModelId: details?.intent.providerModelId ?? stateProviderModel,
      offerId: details?.offerId ?? stateOfferId,
      inputUsdPer1m: details
        ? formatMicroUsd(details.intent.inputMicroUsdPer1m)
        : this.status.inputUsdPer1m,
      outputUsdPer1m: details
        ? formatMicroUsd(details.intent.outputMicroUsdPer1m)
        : this.status.outputUsdPer1m,
      competitorId: details?.competitorId ?? null,
      remainingAllowanceUsd: allowance
        ? formatUsdNanos(allowance.remainingUsdNanos, 6)
        : this.status.remainingAllowanceUsd,
      totalEarnedUsd: details?.totalEarnedMicroUsd === null || details === null
        ? this.status.totalEarnedUsd
        : formatMicroUsd(details.totalEarnedMicroUsd),
      lastSuccessAt: successAt,
      lastError: null,
    };
    this.log(`Surplus controller phase=${phase} model=${this.status.model ?? "none"}`);
  }
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "").toLowerCase();
}
