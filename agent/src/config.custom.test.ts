import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const BASE = {
  SUPPLIER_PRIV_KEY_HEX: "a".repeat(64),
  OGMIOS_URL: "https://example.invalid",
  ADVERT_REF: `${"b".repeat(64)}#0`,
  NETWORK_ID: "1",
};

// The custom kind requires both the service endpoint and the advertised SLA
// (the latter feeds createApp's unconditional SLA boot guard).
const CUSTOM_BASE = {
  ...BASE,
  CAPABILITY_KIND: "custom",
  SERVICE_URL: "http://127.0.0.1:9999/run",
  ADVERT_MAX_PROCESSING_MS: "300000",
};

describe("CAPABILITY_KIND=custom", () => {
  it("requires SERVICE_URL", () => {
    expect(() => loadConfig({ ...BASE, CAPABILITY_KIND: "custom" })).toThrow(/SERVICE_URL/);
  });
  it("loads with defaults", () => {
    const c = loadConfig({ ...CUSTOM_BASE });
    expect(c.capabilityKind).toBe("custom");
    expect(c.serviceUrl).toBe("http://127.0.0.1:9999/run");
    expect(c.serviceTimeoutMs).toBe(120_000);
    expect(c.serviceAuthHeader).toBe("");
    expect(c.serviceContentType).toBe("application/json");
  });
  it("rejects non-integer SERVICE_TIMEOUT_MS", () => {
    expect(() => loadConfig({ ...CUSTOM_BASE, SERVICE_TIMEOUT_MS: "soon" })).toThrow(/SERVICE_TIMEOUT_MS/);
  });
  it("does not require chat/tts/ocr upstreams", () => {
    const c = loadConfig({ ...CUSTOM_BASE });
    expect(c.ollamaUrl).toBe("");
    expect(c.piperUrl).toBe("");
  });
  it("requires ADVERT_MAX_PROCESSING_MS", () => {
    expect(() =>
      loadConfig({ ...BASE, CAPABILITY_KIND: "custom", SERVICE_URL: "http://x" }),
    ).toThrow(/ADVERT_MAX_PROCESSING_MS/);
  });
  it("parses ADVERT_MAX_PROCESSING_MS", () => {
    const c = loadConfig({ ...CUSTOM_BASE, ADVERT_MAX_PROCESSING_MS: "180000" });
    expect(c.advertMaxProcessingMs).toBe(180_000);
  });
  it("rejects non-integer ADVERT_MAX_PROCESSING_MS", () => {
    expect(() => loadConfig({ ...CUSTOM_BASE, ADVERT_MAX_PROCESSING_MS: "5.5" })).toThrow(
      /ADVERT_MAX_PROCESSING_MS/,
    );
  });
  it("leaves ADVERT_MAX_PROCESSING_MS optional for other kinds", () => {
    const c = loadConfig({ ...BASE, CAPABILITY_KIND: "chat", OLLAMA_URL: "http://127.0.0.1:11434" });
    expect(c.advertMaxProcessingMs).toBe(0);
  });
  it("ignores a garbage ADVERT_MAX_PROCESSING_MS for non-custom kinds (parse is scoped to custom)", () => {
    const c = loadConfig({
      ...BASE,
      CAPABILITY_KIND: "chat",
      OLLAMA_URL: "http://127.0.0.1:11434",
      ADVERT_MAX_PROCESSING_MS: "not-a-number",
    });
    expect(c.advertMaxProcessingMs).toBe(0);
  });
});

describe("SERVICE_PRECHECK_URL", () => {
  it("is empty when unset, so that no check runs before the Claim", () => {
    expect(loadConfig({ ...CUSTOM_BASE }).servicePrecheckUrl).toBe("");
  });
  it("is empty when set to an empty text", () => {
    expect(loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "" }).servicePrecheckUrl).toBe("");
  });
  it("keeps an http URL and an https URL as they are", () => {
    expect(loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "http://service:9091/precheck" }).servicePrecheckUrl)
      .toBe("http://service:9091/precheck");
    expect(loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "https://service.example/precheck?v=1" }).servicePrecheckUrl)
      .toBe("https://service.example/precheck?v=1");
  });
  it("rejects a text that is not a URL", () => {
    expect(() => loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "service/precheck" })).toThrow(/SERVICE_PRECHECK_URL/);
  });
  it("rejects a URL with another scheme", () => {
    expect(() => loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "ftp://service/precheck" })).toThrow(/SERVICE_PRECHECK_URL/);
  });
  it("rejects a URL with a user name or a password", () => {
    expect(() => loadConfig({ ...CUSTOM_BASE, SERVICE_PRECHECK_URL: "http://user:secret@service/precheck" }))
      .toThrow(/SERVICE_PRECHECK_URL/);
  });
  it("is not read for another capability kind, so that a bad value in a shared .env does not stop the boot", () => {
    const c = loadConfig({
      ...BASE,
      CAPABILITY_KIND: "chat",
      OLLAMA_URL: "http://127.0.0.1:11434",
      SERVICE_PRECHECK_URL: "not a url",
    });
    expect(c.servicePrecheckUrl).toBe("");
  });
});
