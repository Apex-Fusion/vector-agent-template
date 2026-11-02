const USD_RE = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const NON_NEGATIVE_INT_RE = /^(?:0|[1-9]\d*)$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

export interface SurplusManagerConfig {
  live: boolean;
  apiBaseUrl: string;
  sellerApiKey: string;
  providerApiKey: string;
  providerBaseUrl: string;
  capacityBaseUrl: string;
  perOfferCapUsd: string;
  aggregateCapUsd: string;
  sellerWallet: string;
  payoutAddress: string;
  maxCandidateOrderBooks: number;
  reserveUsd: string;
  maxProviderLimitUsd: string;
  recoveryBps: number;
  undercutBps: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  stopAfterTrades: number;
  settledStatuses: string[];
  statePath: string;
  port: number;
  proof: SurplusProofConfig | null;
}

export interface SurplusProofConfig {
  ogmiosUrl: string;
  walletPrivateKeyHex: string;
  ledgerPath: string;
  reserveLovelace: bigint;
  feeBudgetLovelace: bigint;
  intervalMs: number;
  confirmTimeoutMs: number;
  historyCsvPath: string | null;
  historyOfferId: string | null;
}
export function loadSurplusManagerConfig(
  env: Record<string, string | undefined>,
): SurplusManagerConfig {
  const liveRaw = env.SURPLUS_LIVE;
  if (liveRaw !== undefined && liveRaw !== "" && liveRaw !== "1") {
    throw new Error("SURPLUS_LIVE must be literal 1 or unset");
  }

  const apiBaseUrl = httpsUrl(
    env.SURPLUS_API_URL ?? "https://api.surplusintelligence.ai",
    "SURPLUS_API_URL",
    "api.surplusintelligence.ai",
  );
  const providerBaseUrl = httpsUrl(
    env.SURPLUS_PROVIDER_BASE_URL ?? "https://openrouter.ai/api/v1",
    "SURPLUS_PROVIDER_BASE_URL",
    "openrouter.ai",
  );
  const capacityBaseUrl = httpsUrl(
    env.OPENROUTER_CAPACITY_BASE_URL ?? "https://openrouter.ai/api",
    "OPENROUTER_CAPACITY_BASE_URL",
    "openrouter.ai",
  );

  const sellerWallet = evmAddress(
    required(env, "SURPLUS_SELLER_WALLET"),
    "SURPLUS_SELLER_WALLET",
  );
  const payoutAddress = evmAddress(
    env.SURPLUS_PAYOUT_ADDRESS ?? sellerWallet,
    "SURPLUS_PAYOUT_ADDRESS",
  );

  return {
    live: liveRaw === "1",
    apiBaseUrl,
    sellerApiKey: prefixedSecret(
      required(env, "SURPLUS_SELLER_API_KEY"),
      "SURPLUS_SELLER_API_KEY",
      "si_seller_",
    ),
    providerApiKey: required(env, "SURPLUS_OPENROUTER_API_KEY"),
    providerBaseUrl,
    capacityBaseUrl,
    perOfferCapUsd: usd(
      env.SURPLUS_PER_OFFER_CAP_USD ?? "0.05",
      "SURPLUS_PER_OFFER_CAP_USD",
    ),
    aggregateCapUsd: usd(
      env.SURPLUS_AGGREGATE_CAP_USD ?? "0.05",
      "SURPLUS_AGGREGATE_CAP_USD",
    ),
    sellerWallet,
    payoutAddress,
    maxCandidateOrderBooks: boundedInteger(
      env.SURPLUS_MAX_CANDIDATE_ORDER_BOOKS ?? "10",
      "SURPLUS_MAX_CANDIDATE_ORDER_BOOKS",
      1,
      100,
    ),
    reserveUsd: usd(
      env.SURPLUS_OPENROUTER_RESERVE_USD ?? "1.00",
      "SURPLUS_OPENROUTER_RESERVE_USD",
    ),
    maxProviderLimitUsd: usd(
      env.SURPLUS_OPENROUTER_MAX_LIMIT_USD ?? "20.00",
      "SURPLUS_OPENROUTER_MAX_LIMIT_USD",
    ),
    recoveryBps: boundedInteger(
      env.SURPLUS_MIN_RECOVERY_BPS ?? "490",
      "SURPLUS_MIN_RECOVERY_BPS",
      1,
      10_000,
    ),
    undercutBps: boundedInteger(
      env.SURPLUS_UNDERCUT_BPS ?? "10",
      "SURPLUS_UNDERCUT_BPS",
      0,
      9_999,
    ),
    pollIntervalMs: boundedInteger(
      env.SURPLUS_REPRICE_INTERVAL_MS ?? "300000",
      "SURPLUS_REPRICE_INTERVAL_MS",
      60_000,
      86_400_000,
    ),
    requestTimeoutMs: boundedInteger(
      env.SURPLUS_REQUEST_TIMEOUT_MS ?? "120000",
      "SURPLUS_REQUEST_TIMEOUT_MS",
      1_000,
      300_000,
    ),
    stopAfterTrades: boundedInteger(
      env.SURPLUS_STOP_AFTER_SETTLED_REQUESTS ?? "0",
      "SURPLUS_STOP_AFTER_SETTLED_REQUESTS",
      0,
      1,
    ),
    settledStatuses: statusList(
      env.SURPLUS_SETTLED_STATUSES ?? "",
      "SURPLUS_SETTLED_STATUSES",
    ),
    statePath: requiredWithDefault(
      env.SURPLUS_STATE_PATH,
      "/var/lib/surplus-manager/state.json",
      "SURPLUS_STATE_PATH",
    ),
    port: boundedInteger(env.PORT ?? "8080", "PORT", 1, 65_535),
    proof: loadProofConfig(env),
  };
}

function loadProofConfig(
  env: Record<string, string | undefined>,
): SurplusProofConfig | null {
  const enabledRaw = env.SURPLUS_PROOF_ENABLED;
  if (enabledRaw === undefined || enabledRaw === "") return null;
  if (enabledRaw !== "1") {
    throw new Error("SURPLUS_PROOF_ENABLED must be literal 1 or unset");
  }

  const ogmiosUrl = required(env, "OGMIOS_URL");
  const walletPrivateKeyHex = required(
    env,
    "SURPLUS_PROOF_WALLET_PRIV_KEY_HEX",
  );
  if (!HEX64_RE.test(walletPrivateKeyHex)) {
    throw new Error(
      "SURPLUS_PROOF_WALLET_PRIV_KEY_HEX must be 64 hexadecimal characters",
    );
  }

  const historyCsvPath = env.SURPLUS_PROOF_HISTORY_CSV_PATH?.trim() || null;
  const historyOfferId = historyCsvPath === null
    ? null
    : required(env, "SURPLUS_PROOF_HISTORY_OFFER_ID");

  return {
    ogmiosUrl,
    walletPrivateKeyHex: walletPrivateKeyHex.toLowerCase(),
    ledgerPath: requiredWithDefault(
      env.SURPLUS_PROOF_LEDGER_PATH,
      "/var/lib/surplus-manager/vector-proofs.json",
      "SURPLUS_PROOF_LEDGER_PATH",
    ),
    reserveLovelace: BigInt(boundedInteger(
      env.SURPLUS_PROOF_RESERVE_LOVELACE ?? "5000000",
      "SURPLUS_PROOF_RESERVE_LOVELACE",
      0,
      Number.MAX_SAFE_INTEGER,
    )),
    feeBudgetLovelace: BigInt(boundedInteger(
      env.SURPLUS_PROOF_FEE_BUDGET_LOVELACE ?? "1000000",
      "SURPLUS_PROOF_FEE_BUDGET_LOVELACE",
      1,
      Number.MAX_SAFE_INTEGER,
    )),
    intervalMs: boundedInteger(
      env.SURPLUS_PROOF_INTERVAL_MS ?? "300000",
      "SURPLUS_PROOF_INTERVAL_MS",
      60_000,
      86_400_000,
    ),
    confirmTimeoutMs: boundedInteger(
      env.SURPLUS_PROOF_CONFIRM_TIMEOUT_MS ?? "300000",
      "SURPLUS_PROOF_CONFIRM_TIMEOUT_MS",
      10_000,
      3_600_000,
    ),
    historyCsvPath,
    historyOfferId,
  };
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredWithDefault(
  value: string | undefined,
  fallback: string,
  name: string,
): string {
  const result = (value ?? fallback).trim();
  if (!result) throw new Error(`${name} must not be empty`);
  return result;
}

function prefixedSecret(value: string, name: string, prefix: string): string {
  if (!value.startsWith(prefix) || value.length <= prefix.length) {
    throw new Error(`${name} must start with ${prefix}`);
  }
  return value;
}

function usd(value: string, name: string): string {
  if (!USD_RE.test(value)) {
    throw new Error(`${name} must be a non-negative USD decimal with at most 6 places`);
  }
  return value;
}

function evmAddress(value: string, name: string): string {
  if (!EVM_ADDRESS_RE.test(value)) {
    throw new Error(`${name} must be a 20-byte 0x address`);
  }
  return value.toLowerCase();
}

function boundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const pattern = minimum === 0 ? NON_NEGATIVE_INT_RE : POSITIVE_INT_RE;
  if (!pattern.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function statusList(value: string, name: string): string[] {
  if (value.trim() === "") return [];
  const statuses = value.split(",").map((status) => status.trim().toLowerCase());
  const seen = new Set<string>();
  for (const status of statuses) {
    if (!/^[a-z][a-z0-9_-]*$/.test(status)) {
      throw new Error(`${name} contains an invalid status`);
    }
    if (seen.has(status)) throw new Error(`${name} contains a duplicate status`);
    seen.add(status);
  }
  return statuses;
}

function httpsUrl(value: string, name: string, hostname: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== hostname) {
    throw new Error(`${name} must use https://${hostname}`);
  }
  return value.replace(/\/+$/, "");
}
