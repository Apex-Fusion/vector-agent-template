import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const BASE = {
  SUPPLIER_PRIV_KEY_HEX: "a".repeat(64),
  OGMIOS_URL: "https://example.invalid",
  ADVERT_REF: `${"b".repeat(64)}#0`,
  NETWORK_ID: "1",
};

describe("CAPABILITY_KIND=custom", () => {
  it("requires SERVICE_URL", () => {
    expect(() => loadConfig({ ...BASE, CAPABILITY_KIND: "custom" })).toThrow(/SERVICE_URL/);
  });
  it("loads with defaults", () => {
    const c = loadConfig({ ...BASE, CAPABILITY_KIND: "custom", SERVICE_URL: "http://127.0.0.1:9999/run" });
    expect(c.capabilityKind).toBe("custom");
    expect(c.serviceUrl).toBe("http://127.0.0.1:9999/run");
    expect(c.serviceTimeoutMs).toBe(120_000);
    expect(c.serviceAuthHeader).toBe("");
    expect(c.serviceContentType).toBe("application/json");
  });
  it("rejects non-integer SERVICE_TIMEOUT_MS", () => {
    expect(() =>
      loadConfig({ ...BASE, CAPABILITY_KIND: "custom", SERVICE_URL: "http://x", SERVICE_TIMEOUT_MS: "soon" }),
    ).toThrow(/SERVICE_TIMEOUT_MS/);
  });
  it("does not require chat/tts/ocr upstreams", () => {
    const c = loadConfig({ ...BASE, CAPABILITY_KIND: "custom", SERVICE_URL: "http://x" });
    expect(c.ollamaUrl).toBe("");
    expect(c.piperUrl).toBe("");
  });
});
