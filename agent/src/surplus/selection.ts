import type {
  SurplusDiscoveredModel,
  SurplusMarketSummary,
  SurplusOrderBookOffer,
} from "./client.js";
import {
  quoteSurplusMultiplier,
  usdPer1mToMicroUsd,
  type SurplusCompetitor,
  type SurplusMultiplierQuote,
} from "./policy.js";

export interface SurplusModelCandidate {
  model: string;
  providerModelId: string;
  upstreamInputMicroUsdPer1m: number;
  upstreamOutputMicroUsdPer1m: number;
  requests24h: number;
  volume24h: number;
  summaryQuote: SurplusMultiplierQuote;
}

export function selectSurplusModelCandidates(
  discovered: SurplusDiscoveredModel[],
  markets: SurplusMarketSummary[],
  recoveryBps: number,
  undercutBps: number,
): SurplusModelCandidate[] {
  const marketByModel = new Map(markets.map((market) => [market.model, market]));
  const candidates: SurplusModelCandidate[] = [];
  for (const model of discovered) {
    const market = marketByModel.get(model.model);
    if (
      !market ||
      !model.supported ||
      model.providerModelId === "" ||
      model.availabilityStatus !== "available" ||
      model.modelType !== "text" ||
      model.priceUnit !== "M" ||
      model.priceVariable ||
      model.inputUsdPer1m <= 0 ||
      model.outputUsdPer1m <= 0 ||
      market.healthySellerCount <= 0 ||
      market.bestInputMicroUsdPer1m <= 0 ||
      market.bestOutputMicroUsdPer1m <= 0
    ) {
      continue;
    }
    const inputPrice = usdPer1mToMicroUsd(
      model.inputUsdPer1m,
      `${model.model} discovery input price`,
    );
    const outputPrice = usdPer1mToMicroUsd(
      model.outputUsdPer1m,
      `${model.model} discovery output price`,
    );
    const quote = quoteSurplusMultiplier({
      upstreamInputMicroUsdPer1m: inputPrice,
      upstreamOutputMicroUsdPer1m: outputPrice,
      recoveryBps,
      undercutBps,
      competitors: [{
        id: `summary:${model.model}`,
        inputMicroUsdPer1m: market.bestInputMicroUsdPer1m,
        outputMicroUsdPer1m: market.bestOutputMicroUsdPer1m,
      }],
    });
    if (!quote.competitive) continue;
    candidates.push({
      model: model.model,
      providerModelId: model.providerModelId,
      upstreamInputMicroUsdPer1m: inputPrice,
      upstreamOutputMicroUsdPer1m: outputPrice,
      requests24h: market.requests24h,
      volume24h: market.volume24h,
      summaryQuote: quote,
    });
  }
  return candidates.sort(compareCandidates);
}

export function eligibleCompetitors(
  offers: SurplusOrderBookOffer[],
  sellerWallet: string,
  ownOfferIds: ReadonlySet<string>,
): SurplusCompetitor[] {
  const normalizedWallet = sellerWallet.toLowerCase();
  return offers
    .filter((offer) =>
      offer.available &&
      offer.healthy &&
      offer.seller !== normalizedWallet &&
      !ownOfferIds.has(offer.id)
    )
    .map((offer) => ({
      id: offer.id,
      inputMicroUsdPer1m: offer.inputMicroUsdPer1m,
      outputMicroUsdPer1m: offer.outputMicroUsdPer1m,
    }));
}

function compareCandidates(
  left: SurplusModelCandidate,
  right: SurplusModelCandidate,
): number {
  return right.requests24h - left.requests24h ||
    right.volume24h - left.volume24h ||
    left.model.localeCompare(right.model) ||
    left.providerModelId.localeCompare(right.providerModelId);
}
