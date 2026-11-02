import { readFile } from "node:fs/promises";

export interface ResellerSetupConfig {
  networkId: 1;
  ogmiosUrl: string;
  endpointUrl: string;
  marketplaceModel: string;
  openRouterModel: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxProcessingMs: number;
  inferenceTimeoutMs: number;
  priceLovelace: bigint;
  supplierBondLovelace: bigint;
  buyerBondLovelace: bigint;
  reserveUsd: string;
  pollIntervalMs: number;
  providerTimeoutMs: number;
  previewMaxChars: number;
  minimumWalletLovelace: bigint;
  fundingTimeoutMs: number;
  composeFile: string;
}

export async function loadResellerSetupConfig(
  path: string,
): Promise<ResellerSetupConfig> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`unable to read reseller config ${path}: ${detail}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("reseller config must be a JSON object");
  }
  const value = parsed as Record<string, unknown>;
  const networkId = integerField(value, "networkId");
  if (networkId !== 1) throw new Error("reseller config networkId must be 1");

  const endpoint = new URL(urlField(value, "endpointUrl", ["https:"]));
  if (
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname.replace(/\/+$/, "") !== ""
  ) {
    throw new Error(
      "reseller config endpointUrl must be a plain HTTPS origin without credentials, path, query, or fragment",
    );
  }
  const endpointUrl = endpoint.origin;

  const previewMaxChars = optionalInteger(value, "previewMaxChars", 160);
  if (previewMaxChars > 1000) {
    throw new Error("reseller config previewMaxChars must not exceed 1000");
  }
  const providerTimeoutMs = optionalInteger(value, "providerTimeoutMs", 10_000);
  const maxProcessingMs = integerField(value, "maxProcessingMs");
  const settlementMarginMs = 150_000 + providerTimeoutMs;
  const defaultInferenceTimeoutMs = maxProcessingMs - settlementMarginMs;
  if (defaultInferenceTimeoutMs <= 0) {
    throw new Error(
      "reseller config maxProcessingMs does not leave time for provider checks and chain settlement",
    );
  }
  const inferenceTimeoutMs = value.inferenceTimeoutMs === undefined
    ? defaultInferenceTimeoutMs
    : integerField(value, "inferenceTimeoutMs");
  if (inferenceTimeoutMs + settlementMarginMs > maxProcessingMs) {
    throw new Error(
      "reseller config inferenceTimeoutMs does not leave time for provider checks and chain settlement",
    );
  }


  return {
    networkId: 1,
    ogmiosUrl: urlField(value, "ogmiosUrl", ["http:", "https:"]),
    endpointUrl,
    marketplaceModel: stringField(value, "marketplaceModel"),
    openRouterModel: stringField(value, "openRouterModel"),
    maxInputTokens: integerField(value, "maxInputTokens"),
    maxOutputTokens: integerField(value, "maxOutputTokens"),
    maxProcessingMs,
    inferenceTimeoutMs,
    priceLovelace: bigintField(value, "priceLovelace"),
    supplierBondLovelace: bigintField(value, "supplierBondLovelace"),
    buyerBondLovelace: bigintField(value, "buyerBondLovelace"),
    reserveUsd: usdField(value, "reserveUsd"),
    pollIntervalMs: optionalInteger(value, "pollIntervalMs", 30_000),
    providerTimeoutMs,
    previewMaxChars,
    minimumWalletLovelace: optionalBigint(value, "minimumWalletLovelace", 20_000_000n),
    fundingTimeoutMs: optionalInteger(value, "fundingTimeoutMs", 3_600_000),
    composeFile: stringField(value, "composeFile"),
  };
}

function stringField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (typeof field !== "string" || field.trim() === "") {
    throw new Error(`reseller config ${name} must be a non-empty string`);
  }
  if (/[\r\n]/.test(field)) {
    throw new Error(`reseller config ${name} must be one line`);
  }
  return field.trim();
}

function urlField(
  value: Record<string, unknown>,
  name: string,
  protocols: string[],
): string {
  const raw = stringField(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`reseller config ${name} must be a valid URL`);
  }
  if (!protocols.includes(url.protocol)) {
    throw new Error(
      `reseller config ${name} must use ${protocols.join(" or ")}`,
    );
  }
  return raw;
}

function integerField(value: Record<string, unknown>, name: string): number {
  const field = value[name];
  if (!Number.isSafeInteger(field) || (field as number) <= 0) {
    throw new Error(`reseller config ${name} must be a positive safe integer`);
  }
  return field as number;
}

function optionalInteger(
  value: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  return value[name] === undefined ? fallback : integerField(value, name);
}

function bigintField(value: Record<string, unknown>, name: string): bigint {
  const field = value[name];
  if (typeof field !== "string" || !/^[1-9]\d*$/.test(field)) {
    throw new Error(`reseller config ${name} must be a positive integer string`);
  }
  return BigInt(field);
}

function optionalBigint(
  value: Record<string, unknown>,
  name: string,
  fallback: bigint,
): bigint {
  return value[name] === undefined ? fallback : bigintField(value, name);
}

function usdField(value: Record<string, unknown>, name: string): string {
  const field = value[name];
  if (
    typeof field !== "string" ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(field)
  ) {
    throw new Error(
      `reseller config ${name} must be a non-negative decimal string`,
    );
  }
  return field;
}
