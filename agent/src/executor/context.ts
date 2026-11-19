/**
 * agent/src/executor/context.ts — the job context that the runtime sends to the
 * service, on the call before the Claim and on the job call.
 *
 * The runtime builds the context from the escrow and the advert that it read
 * from the chain. Nothing in it comes from the request of the buyer. The runtime
 * builds its own header set for each call to the service and passes no header
 * of the buyer on, so a buyer cannot set one of these headers.
 */

import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";

import type { JobContext } from "./executor.js";

/** The six headers, in lower case, as fetch sends them. */
export const CONTEXT_HEADER_NAMES = [
  "x-vector-escrow-ref",
  "x-vector-advert-ref",
  "x-vector-advert-model",
  "x-vector-buyer-pkh",
  "x-vector-payment-lovelace",
  "x-vector-deliver-by-ms",
] as const;

export interface JobContextSource {
  /** The escrow reference of the job: "<64 hex>#<index>". */
  escrowRef: string;
  escrow: Pick<EscrowDatum, "advert_ref" | "buyer_pkh" | "payment_lovelace" | "deliver_by">;
  advert: Pick<AdvertDatum, "model">;
}

/**
 * The context of one job. The escrow reference is in lower case: the service
 * matches the call before the Claim with the job call by this value.
 */
export function jobContext({ escrowRef, escrow, advert }: JobContextSource): JobContext {
  return {
    escrowRef: escrowRef.toLowerCase(),
    advertRef: `${escrow.advert_ref.txHash.toLowerCase()}#${escrow.advert_ref.index}`,
    advertModel: advert.model,
    buyerPkh: escrow.buyer_pkh,
    paymentLovelace: escrow.payment_lovelace.toString(),
    deliverByMs: escrow.deliver_by,
  };
}

/**
 * The headers for one call to the service. The advert model is percent-encoded
 * (decode it with decodeURIComponent): the model is free text on the chain, and
 * a header value takes visible ASCII only. A plain name stays as it is.
 */
export function contextHeaders(context: JobContext): Record<string, string> {
  return {
    "x-vector-escrow-ref": context.escrowRef,
    "x-vector-advert-ref": context.advertRef,
    "x-vector-advert-model": encodeURIComponent(context.advertModel),
    "x-vector-buyer-pkh": context.buyerPkh,
    "x-vector-payment-lovelace": context.paymentLovelace,
    "x-vector-deliver-by-ms": String(context.deliverByMs),
  };
}
