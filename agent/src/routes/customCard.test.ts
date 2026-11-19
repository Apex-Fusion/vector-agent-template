/**
 * agent/src/routes/customCard.test.ts — the agent card and GET /.
 *
 * The card must pass the check that the identity gateway makes at the endpoint
 * of a record (the card rule of identity-gateway/src/fetch/detect.ts in
 * agents-marketplace). `gatewayAcceptsCard` below follows that rule.
 */

import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";

import { MockChainProvider, type OutputReference } from "@marketplace/shared/chain";
import { encodeAdvertDatum, type AdvertDatum } from "@marketplace/shared/cbor";

import { CARD_PATH, buildAgentCard, mountAgentCard, parsePublicOrigin } from "./customCard.js";

// ─── The rule of the identity gateway ──────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const fits = (text: string, maxBytes: number): boolean => Buffer.byteLength(text, "utf8") <= maxBytes;

interface Interface { url: string; protocolBinding: string; protocolVersion: string }

/**
 * What the gateway keeps of a valid card, or null when it refuses the card. The
 * card needs a name, a description, a version, an object `capabilities`, two
 * non-empty lists of modes, skills with an id and a name, and at least one
 * interface on the https origin of the record endpoint.
 */
function gatewayAcceptsCard(value: unknown, origin: string): { interfaces: Interface[] } | null {
  if (!isObject(value)) return null;
  if (!isText(value.name) || typeof value.description !== "string" || typeof value.version !== "string" || !isObject(value.capabilities)) return null;
  if (!isTextList(value.defaultInputModes) || value.defaultInputModes.length === 0) return null;
  if (!isTextList(value.defaultOutputModes) || value.defaultOutputModes.length === 0) return null;
  if (!Array.isArray(value.skills) || !value.skills.every((s) => isObject(s) && isText(s.id) && isText(s.name))) return null;
  if (!Array.isArray(value.supportedInterfaces) || value.supportedInterfaces.length === 0) return null;
  const onOrigin: Interface[] = [];
  for (const i of value.supportedInterfaces) {
    if (!isObject(i) || !isText(i.url) || !isText(i.protocolBinding) || !isText(i.protocolVersion)) return null;
    const sameOrigin = (() => {
      try {
        const parsed = new URL(i.url);
        return parsed.protocol === "https:" && parsed.origin === origin;
      } catch {
        return false;
      }
    })();
    if (fits(i.url, 512) && fits(i.protocolBinding, 64) && fits(i.protocolVersion, 64) && sameOrigin) {
      onOrigin.push({ url: i.url, protocolBinding: i.protocolBinding, protocolVersion: i.protocolVersion });
    }
  }
  return onOrigin.length > 0 ? { interfaces: onOrigin } : null;
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

const ORIGIN = "https://agent.example.com";
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };

const advert: AdvertDatum = {
  supplier_pkh: "3f".repeat(28),
  capability_id: "records.extract.myproduct.v1",
  model: "my-product-v1",
  max_output_tokens: 8192,
  max_processing_ms: 300_000,
  price_lovelace: 2_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: ORIGIN,
  detail_uri: "",
  detail_hash: "a".repeat(64),
  advertised_at: 0,
  status: "Active",
};

function chainWithAdvert(): MockChainProvider {
  const chain = new MockChainProvider();
  chain.seed({
    ref: ADVERT_REF,
    address: "addr_test1_advert",
    lovelace: 2_000_000n,
    assets: {},
    datumHex: encodeAdvertDatum(advert),
    scriptRef: null,
  });
  return chain;
}

function appWith(options: { chain?: MockChainProvider; publicOrigin?: string; now?: () => number } = {}) {
  const app = express();
  mountAgentCard(app, {
    chain: options.chain ?? chainWithAdvert(),
    config: { publicOrigin: options.publicOrigin ?? ORIGIN, advertRef: ADVERT_REF },
    now: options.now,
  });
  return app;
}

describe("the agent card", () => {
  it("has the fields of the contract, with the capability and the model of the advert", async () => {
    const res = await request(appWith()).get(CARD_PATH);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.body).toEqual({
      name: "my-product-v1",
      description: expect.stringContaining("records.extract.myproduct.v1"),
      version: "1",
      capabilities: {},
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ id: "records.extract.myproduct.v1", name: "records.extract.myproduct.v1" }],
      supportedInterfaces: [{ url: `${ORIGIN}/v1/job`, protocolBinding: "vector-job-v1", protocolVersion: "1" }],
    });
  });

  it("passes the card rule of the identity gateway for the origin of the record endpoint", async () => {
    const res = await request(appWith()).get(CARD_PATH);

    const origin = new URL("https://agent.example.com/").origin;
    expect(gatewayAcceptsCard(res.body, origin)).toEqual({
      interfaces: [{ url: `${origin}/v1/job`, protocolBinding: "vector-job-v1", protocolVersion: "1" }],
    });
  });

  it("is refused by the same rule for an endpoint on another origin (the check is not empty)", async () => {
    const res = await request(appWith()).get(CARD_PATH);

    expect(gatewayAcceptsCard(res.body, "https://other.example.com")).toBeNull();
    expect(gatewayAcceptsCard({ ...res.body, supportedInterfaces: [] }, ORIGIN)).toBeNull();
    expect(gatewayAcceptsCard({ ...res.body, defaultInputModes: [] }, ORIGIN)).toBeNull();
    expect(gatewayAcceptsCard({ ...res.body, skills: [{ id: "x" }] }, ORIGIN)).toBeNull();
  });

  it("is live before the advert exists: a valid card with no skill", async () => {
    const res = await request(appWith({ chain: new MockChainProvider() })).get(CARD_PATH);

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([]);
    expect(gatewayAcceptsCard(res.body, ORIGIN)).not.toBeNull();
  });

  it("is live when the chain cannot be read: a valid card with no skill", async () => {
    const chain = chainWithAdvert();
    chain.queryUtxo = async () => {
      throw new Error("node down");
    };

    const res = await request(appWith({ chain })).get(CARD_PATH);

    expect(res.status).toBe(200);
    expect(res.body.skills).toEqual([]);
    expect(gatewayAcceptsCard(res.body, ORIGIN)).not.toBeNull();
  });

  it("takes the origin from the setting, never from the request", async () => {
    const res = await request(appWith()).get(CARD_PATH).set("host", "evil.example").set("x-forwarded-host", "evil.example");

    expect(res.body.supportedInterfaces[0].url).toBe(`${ORIGIN}/v1/job`);
    expect(JSON.stringify(res.body)).not.toContain("evil.example");
  });

  it("reads the advert once in the cache window and again after it", async () => {
    const chain = chainWithAdvert();
    const read = vi.spyOn(chain, "queryUtxo");
    let now = 1_000_000;
    const app = appWith({ chain, now: () => now });

    await request(app).get(CARD_PATH);
    await request(app).get(CARD_PATH);
    expect(read).toHaveBeenCalledTimes(1);

    now += 29_999;
    await request(app).get(CARD_PATH);
    expect(read).toHaveBeenCalledTimes(1);

    now += 1;
    await request(app).get(CARD_PATH);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("builds a card with a long text cut to a small size", () => {
    const card = buildAgentCard(ORIGIN, { capabilityId: "c".repeat(1_000), model: "m".repeat(1_000) });

    expect(card.name).toHaveLength(256);
    expect(card.skills[0]!.id).toHaveLength(256);
    expect(gatewayAcceptsCard(card, ORIGIN)).not.toBeNull();
  });
});

describe("GET /", () => {
  it("answers 200 with a pointer to the card, without a read of the chain", async () => {
    const chain = chainWithAdvert();
    const read = vi.spyOn(chain, "queryUtxo");

    const res = await request(appWith({ chain })).get("/");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, agent_card: `${ORIGIN}${CARD_PATH}` });
    expect(read).not.toHaveBeenCalled();
  });

  it("answers HEAD on both routes with the status of the GET", async () => {
    const app = appWith();

    expect((await request(app).head("/")).status).toBe(200);
    expect((await request(app).head(CARD_PATH)).status).toBe(200);
  });
});

describe("without a public origin", () => {
  it("mounts nothing: both routes answer 404", async () => {
    const app = appWith({ publicOrigin: "" });

    expect((await request(app).get("/")).status).toBe(404);
    expect((await request(app).get(CARD_PATH)).status).toBe(404);
  });
});

describe("parsePublicOrigin", () => {
  it("keeps an https origin", () => {
    expect(parsePublicOrigin("https://agent.example.com")).toBe("https://agent.example.com");
  });
  it("takes the origin of the URL, as the gateway does", () => {
    expect(parsePublicOrigin("https://agent.example.com/")).toBe("https://agent.example.com");
    expect(parsePublicOrigin("https://Agent.Example.COM:443")).toBe("https://agent.example.com");
    expect(parsePublicOrigin("https://agent.example.com:8443")).toBe("https://agent.example.com:8443");
  });
  it.each([
    ["not a URL", "agent.example.com"],
    ["a plain http URL", "http://agent.example.com"],
    ["a path", "https://agent.example.com/agent"],
    ["a query", "https://agent.example.com/?x=1"],
    ["a fragment", "https://agent.example.com/#top"],
    ["a user name", "https://user@agent.example.com"],
    ["a password", "https://user:secret@agent.example.com"],
    ["a text that makes the interface URL longer than 512 bytes", `https://${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.${"e".repeat(60)}.${"f".repeat(60)}.${"g".repeat(60)}.${"h".repeat(60)}.example.com`],
  ])("rejects %s", (_name, value) => {
    expect(() => parsePublicOrigin(value)).toThrow(/PUBLIC_ORIGIN/);
  });
});
