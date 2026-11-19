import { describe, it, expect } from "vitest";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";

import { CONTEXT_HEADER_NAMES, contextHeaders, jobContext } from "./context.js";

const escrow = {
  advert_ref: { txHash: "a".repeat(64), index: 3 },
  buyer_pkh: "4f".repeat(28),
  payment_lovelace: 12_345_678_901_234_567_890n,
  deliver_by: 1_900_000_000_000,
} as unknown as EscrowDatum;
const advert = { model: "lot-medium" } as unknown as AdvertDatum;

describe("jobContext", () => {
  it("takes every value from the escrow and the advert", () => {
    expect(jobContext({ escrowRef: `${"c".repeat(64)}#2`, escrow, advert })).toEqual({
      escrowRef: `${"c".repeat(64)}#2`,
      advertRef: `${"a".repeat(64)}#3`,
      advertModel: "lot-medium",
      buyerPkh: "4f".repeat(28),
      paymentLovelace: "12345678901234567890",
      deliverByMs: 1_900_000_000_000,
    });
  });

  it("writes the escrow reference in the lower case, so that two calls for one escrow carry one value", () => {
    const lower = jobContext({ escrowRef: `${"ab".repeat(32)}#1`, escrow, advert });
    const upper = jobContext({ escrowRef: `${"AB".repeat(32)}#1`, escrow, advert });
    expect(upper.escrowRef).toBe(`${"ab".repeat(32)}#1`);
    expect(upper).toEqual(lower);
  });
});

describe("contextHeaders", () => {
  const context = jobContext({ escrowRef: `${"c".repeat(64)}#2`, escrow, advert });

  it("has the six names of the contract and no other", () => {
    expect(Object.keys(contextHeaders(context)).sort()).toEqual([
      "x-vector-advert-model",
      "x-vector-advert-ref",
      "x-vector-buyer-pkh",
      "x-vector-deliver-by-ms",
      "x-vector-escrow-ref",
      "x-vector-payment-lovelace",
    ]);
    expect(Object.keys(contextHeaders(context)).sort()).toEqual([...CONTEXT_HEADER_NAMES].sort());
  });

  it("writes each value as text", () => {
    expect(contextHeaders(context)).toEqual({
      "x-vector-escrow-ref": `${"c".repeat(64)}#2`,
      "x-vector-advert-ref": `${"a".repeat(64)}#3`,
      "x-vector-advert-model": "lot-medium",
      "x-vector-buyer-pkh": "4f".repeat(28),
      "x-vector-payment-lovelace": "12345678901234567890",
      "x-vector-deliver-by-ms": "1900000000000",
    });
  });

  it("percent-encodes the advert model and leaves the other values as they are", () => {
    const headers = contextHeaders({ ...context, advertModel: "lot medium/é" });
    expect(headers["x-vector-advert-model"]).toBe("lot%20medium%2F%C3%A9");
    expect(headers["x-vector-escrow-ref"]).toBe(context.escrowRef);
  });
});
