import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveOgmiosProvider, type OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, IdentityAdvertDatum } from "@marketplace/shared/cbor";
import {
  BOUNDED_INPUT_DETAIL_MARKER,
  isIdentityAdvertDatum,
  loadBlueprint,
  loadIdentityBlueprint,
  type WalletKey,
} from "@marketplace/shared/tx";
import { decodeAdvert, parseAgentId, supplierIdentity } from "../identity/agent.js";
import { deriveKeypair } from "./gen-keypair.js";
import { runPostAdvert } from "./postAdvertFlow.js";
import { callResponses } from "../openai.js";
import { OpenRouterCapacityProvider } from "../reseller/openRouterCapacity.js";
import {
  loadResellerSetupConfig,
  type ResellerSetupConfig,
} from "../reseller/setupConfig.js";

interface CliOptions {
  configPath: string;
  startStack: boolean;
}

interface SetupState extends Record<string, string> {
  SUPPLIER_PRIV_KEY_HEX: string;
  SUPPLIER_PUB_KEY_HEX: string;
  SUPPLIER_PKH: string;
  SUPPLIER_ADDRESS: string;
  POSTGRES_PASSWORD: string;
  OPENAI_API_KEY: string;
  ADVERT_REF: string;
}

interface SetupResult {
  supplierAddress: string;
  supplierPkh: string;
  advertRef: string;
  /** The agent of a new advert, or null for a legacy advert. */
  agentId: string | null;
  endpointUrl: string;
  dashboardUrl: string;
  marketplaceModel: string;
  providerModel: string;
  stackStarted: boolean;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";
const SHA256_EMPTY = createHash("sha256").update("").digest("hex");
const MAINNET_ZERO_TIME_MS = "1756485600000";
const MAINNET_ESCROW_REF =
  "c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#0";
const MAINNET_ADVERT_REF =
  "c8d84c6d67ec67a1efe5e9c6c06d53020e05d1bb96d1c55ecb1eb7d5010c4d54#1";
const POSTGRES_STATE_FILE =
  "/var/lib/agents-marketplace/openrouter-reseller-postgres.env";
const DEFAULT_STATE_FILE = "/var/lib/agents-marketplace/openrouter-reseller.env";
const RESELLER_HOSTNAME =
  "mp-suppliers-openrouter-reseller.vector.apexfusion.org";
/**
 * Identity settings (Part 2 §9.6), from the environment or the saved state.
 * They go into the runtime state, and into this process for the in-process
 * advert builder. AGENT_ID selects a new advert; its record must list the
 * seller key first (tx:register-record).
 */
const IDENTITY_SETTINGS = ["IDENTITY_POLICY_ID", "IDENTITY_ESCROW_REF_UTXO", "IDENTITY_ADVERT_REF_UTXO", "AGENT_ID"] as const;

export function parseSetupArgs(argv: string[]): CliOptions {
  let configPath = "";
  let startStack = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
    } else if (arg === "--no-start") {
      startStack = false;
    } else {
      throw new Error(`unknown setup argument: ${arg}`);
    }
  }
  if (configPath === "") throw new Error("--config is required");
  return { configPath, startStack };
}

export async function runResellerSetup(
  options: CliOptions,
  env: Record<string, string | undefined>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<SetupResult> {
  const config = await loadResellerSetupConfig(
    resolve(REPO_ROOT, options.configPath),
  );
  if (new URL(config.endpointUrl).hostname !== RESELLER_HOSTNAME) {
    throw new Error(`endpointUrl host must be ${RESELLER_HOSTNAME}`);
  }
  const statePath = resolveStatePath(env.RESELLER_STATE_FILE, options.startStack);
  process.env.VECTOR_ZERO_TIME_MS = MAINNET_ZERO_TIME_MS;
  process.env.ESCROW_REF_UTXO = MAINNET_ESCROW_REF;
  process.env.ADVERT_REF_UTXO = MAINNET_ADVERT_REF;
  const prior = await readState(statePath);
  const privateKey = prior.SUPPLIER_PRIV_KEY_HEX ?? randomBytes(32).toString("hex");
  const derived = deriveKeypair(privateKey, config.networkId);
  const postgresPassword = prior.POSTGRES_PASSWORD ?? randomBytes(24).toString("hex");
  const openRouterKey = env.OPENROUTER_API_KEY ?? prior.OPENAI_API_KEY;
  if (!openRouterKey) {
    throw new Error("OPENROUTER_API_KEY is required on the first setup run");
  }
  const identitySettings: Record<string, string> = {};
  for (const name of IDENTITY_SETTINGS) {
    const value = env[name] || prior[name];
    if (value) {
      identitySettings[name] = value;
      process.env[name] = value;
    }
  }
  const agentId = parseAgentId(identitySettings.AGENT_ID);

  const runtimeState = buildRuntimeState(
    config,
    {
      privateKeyHex: derived.privateKeyHex,
      pubKeyHex: derived.publicKeyHex,
      pubKeyHash: derived.pubKeyHash,
      address: derived.address,
    },
    postgresPassword,
    openRouterKey,
    prior.ADVERT_REF ?? "",
    identitySettings,
  );
  await writeState(statePath, runtimeState);
  await writeState(POSTGRES_STATE_FILE, {
    POSTGRES_USER: runtimeState.POSTGRES_USER,
    POSTGRES_DB: runtimeState.POSTGRES_DB,
    POSTGRES_PASSWORD: runtimeState.POSTGRES_PASSWORD,
  });

  log("checking capped OpenRouter allowance and model pricing");
  const capacity = new OpenRouterCapacityProvider({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: openRouterKey,
    timeoutMs: config.providerTimeoutMs,
  });
  await capacity.readCapacity(config.openRouterModel);

  log("running one-token OpenRouter inference probe");
  await callResponses({
    baseUrl: OPENROUTER_BASE_URL,
    apiKey: openRouterKey,
    upstreamApi: "responses",
    model: config.openRouterModel,
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Reply OK" }],
    }],
    max_output_tokens: 1,
    maxTokens: 1,
    disableReasoning: true,
    timeoutMs: config.inferenceTimeoutMs,
  });

  const chain = new LiveOgmiosProvider({ ogmiosUrl: config.ogmiosUrl });
  log(`seller wallet ${derived.address}`);
  await waitForFunding(
    chain,
    derived.address,
    config.minimumWalletLovelace,
    config.fundingTimeoutMs,
    log,
  );

  const walletKey: WalletKey = {
    privateKeyHex: derived.privateKeyHex,
    pubKeyHex: derived.publicKeyHex,
    pubKeyHash: derived.pubKeyHash,
    address: derived.address,
  };
  const advert = buildAdvert(config, walletKey, agentId);
  if (agentId === undefined && identitySettings.IDENTITY_POLICY_ID !== undefined) {
    log("warning: no AGENT_ID, so this posts a legacy advert; it lists only until the switch");
  }
  const advertRef = await findOrPostAdvert(
    chain,
    walletKey,
    advert,
    runtimeState.ADVERT_REF,
    log,
    async (pendingRef) => {
      runtimeState.ADVERT_REF = `${pendingRef.txHash}#${pendingRef.index}`;
      await writeState(statePath, runtimeState);
    },
  );
  runtimeState.ADVERT_REF = `${advertRef.txHash}#${advertRef.index}`;
  await writeState(statePath, runtimeState);

  if (options.startStack) {
    log("starting reseller and Postgres stack");
    await runCompose(config.composeFile);
  }

  return {
    supplierAddress: walletKey.address,
    supplierPkh: walletKey.pubKeyHash,
    advertRef: runtimeState.ADVERT_REF,
    agentId: agentId ?? null,
    endpointUrl: config.endpointUrl,
    dashboardUrl: `${config.endpointUrl}/reseller`,
    marketplaceModel: config.marketplaceModel,
    providerModel: config.openRouterModel,
    stackStarted: options.startStack,
  };
}

function buildRuntimeState(
  config: ResellerSetupConfig,
  wallet: WalletKey,
  postgresPassword: string,
  openRouterKey: string,
  advertRef: string,
  identitySettings: Record<string, string>,
): SetupState {
  const hostname = new URL(config.endpointUrl).hostname;
  return {
    SUPPLIER_PRIV_KEY_HEX: wallet.privateKeyHex,
    SUPPLIER_PUB_KEY_HEX: wallet.pubKeyHex,
    SUPPLIER_PKH: wallet.pubKeyHash,
    SUPPLIER_ADDRESS: wallet.address,
    POSTGRES_USER: "reseller",
    POSTGRES_DB: "reseller",
    POSTGRES_PASSWORD: postgresPassword,
    OPENAI_API_KEY: openRouterKey,
    ADVERT_REF: advertRef,
    OGMIOS_URL: config.ogmiosUrl,
    NETWORK_ID: String(config.networkId),
    LIVE_CHAIN: "1",
    CAPABILITY_KIND: "chat",
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: OPENROUTER_BASE_URL,
    OPENAI_UPSTREAM_API: "responses",
    OPENAI_MODEL_OVERRIDE: config.openRouterModel,
    OPENAI_MAX_TOKENS: String(config.maxOutputTokens),
    OPENAI_REASONING: "off",
    OPENAI_TIMEOUT_MS: String(config.inferenceTimeoutMs),
    RESELLER_PROVIDER: "openrouter",
    RESELLER_DATABASE_URL: `postgresql://reseller:${postgresPassword}@postgres:5432/reseller`,
    RESELLER_RESERVE_USD: config.reserveUsd,
    RESELLER_MAX_INPUT_TOKENS: String(config.maxInputTokens),
    RESELLER_POLL_INTERVAL_MS: String(config.pollIntervalMs),
    RESELLER_PROVIDER_TIMEOUT_MS: String(config.providerTimeoutMs),
    RESELLER_PREVIEW_MAX_CHARS: String(config.previewMaxChars),
    RESELLER_HOSTNAME: hostname,
    RESELLER_ENDPOINT_URL: config.endpointUrl,
    RESELLER_MARKETPLACE_MODEL: config.marketplaceModel,
    RESELLER_PROVIDER_MODEL: config.openRouterModel,
    PORT: "8080",
    WALLET_HEALTH_INTERVAL_MS: "600000",
    VECTOR_ZERO_TIME_MS: MAINNET_ZERO_TIME_MS,
    ESCROW_REF_UTXO: MAINNET_ESCROW_REF,
    ADVERT_REF_UTXO: MAINNET_ADVERT_REF,
    ...identitySettings,
  };
}

function buildAdvert(
  config: ResellerSetupConfig,
  wallet: WalletKey,
  agentId: string | undefined,
): AdvertDatum | IdentityAdvertDatum {
  const advert: AdvertDatum = {
    supplier_pkh: wallet.pubKeyHash,
    capability_id: "llm.text.generate.v1",
    model: config.marketplaceModel,
    max_output_tokens: config.maxOutputTokens,
    max_processing_ms: config.maxProcessingMs,
    price_lovelace: config.priceLovelace,
    supplier_bond_lovelace: config.supplierBondLovelace,
    buyer_bond_lovelace: config.buyerBondLovelace,
    endpoint_url: config.endpointUrl,
    detail_uri: BOUNDED_INPUT_DETAIL_MARKER,
    detail_hash: SHA256_EMPTY,
    advertised_at: 0,
    status: "Active",
  };
  return agentId === undefined ? advert : { ...advert, agent_id: agentId };
}

async function findOrPostAdvert(
  chain: LiveOgmiosProvider,
  walletKey: WalletKey,
  expected: AdvertDatum | IdentityAdvertDatum,
  savedRef: string,
  log: (line: string) => void,
  journal: (ref: OutputReference) => Promise<void>,
): Promise<OutputReference> {
  const parsedSaved = parseRef(savedRef);
  if (parsedSaved) {
    let saved = await chain.queryUtxo(parsedSaved);
    let pending = false;
    if (!saved?.datumHex) {
      try {
        await chain.awaitTx(parsedSaved.txHash, 120_000);
        saved = await chain.queryUtxo(parsedSaved);
        pending = true;
      } catch {
        // The pending transaction is no longer viable; authoritative scan follows.
        saved = null;
      }
    }
    if (saved?.datumHex) {
      const datum = decodeAdvert(saved.datumHex).datum;
      // A new advert replaces a legacy one (Part 2 §9.2): the saved advert of the other layout stays until retired.
      if (isIdentityAdvertDatum(datum) === isIdentityAdvertDatum(expected)) {
        assertAdvertMatches(datum, expected);
        log(`reusing ${pending ? "confirmed pending" : "saved"} advert ${savedRef}`);
        return parsedSaved;
      }
      log(`saved advert ${savedRef} has the other layout; it stays until you retire it (tx:retire-advert)`);
    }
  }

  // Both advert addresses during the drain; only the layout of `expected` counts.
  const advertAddresses = [loadBlueprint().advertScriptAddress(1)];
  try {
    advertAddresses.push(loadIdentityBlueprint().advertScriptAddress(1));
  } catch (error) {
    if (isIdentityAdvertDatum(expected)) throw error;
  }
  const own: Array<{ ref: OutputReference; datum: AdvertDatum | IdentityAdvertDatum }> = [];
  for (const address of advertAddresses) {
    for (const utxo of await chain.queryUtxosByAddress(address)) {
      if (!utxo.datumHex) continue;
      try {
        const datum = decodeAdvert(utxo.datumHex).datum;
        if (datum.status === "Active" && datum.model === expected.model &&
            datum.supplier_pkh === expected.supplier_pkh &&
            isIdentityAdvertDatum(datum) === isIdentityAdvertDatum(expected)) {
          own.push({ ref: utxo.ref, datum });
        }
      } catch {
        // Ignore unrelated or malformed script outputs.
      }
    }
  }
  if (own.length > 1) {
    throw new Error(`multiple active adverts already exist for ${expected.model}`);
  }
  if (own.length === 1) {
    assertAdvertMatches(own[0].datum, expected);
    log(`reusing discovered advert ${own[0].ref.txHash}#${own[0].ref.index}`);
    return own[0].ref;
  }

  const result = await runPostAdvert({
    chain,
    walletKey,
    advertDatum: expected,
    log,
    beforeSubmit: async (built) => journal(built.advertOutputRef),
    identity: isIdentityAdvertDatum(expected) ? supplierIdentity(chain, 1) : undefined,
  });
  return result.advertRef;
}

function assertAdvertMatches(
  actual: AdvertDatum | IdentityAdvertDatum,
  expected: AdvertDatum | IdentityAdvertDatum,
): void {
  const fieldsMatch =
    actual.status === "Active" &&
    actual.supplier_pkh === expected.supplier_pkh &&
    actual.capability_id === expected.capability_id &&
    actual.model === expected.model &&
    actual.max_output_tokens === expected.max_output_tokens &&
    actual.max_processing_ms === expected.max_processing_ms &&
    actual.price_lovelace === expected.price_lovelace &&
    actual.supplier_bond_lovelace === expected.supplier_bond_lovelace &&
    actual.buyer_bond_lovelace === expected.buyer_bond_lovelace &&
    actual.endpoint_url === expected.endpoint_url &&
    actual.detail_uri === expected.detail_uri &&
    actual.detail_hash === expected.detail_hash &&
    (isIdentityAdvertDatum(actual) ? actual.agent_id : null) ===
      (isIdentityAdvertDatum(expected) ? expected.agent_id : null);
  if (!fieldsMatch) {
    throw new Error("saved advert does not match the reseller config");
  }
}


async function waitForFunding(
  chain: LiveOgmiosProvider,
  address: string,
  minimum: bigint,
  timeoutMs: number,
  log: (line: string) => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastReported = -1n;
  while (Date.now() < deadline) {
    const utxos = await chain.queryUtxosByAddress(address);
    const total = utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
    if (total >= minimum) return;
    if (total !== lastReported) {
      log(`wallet funding ${total}/${minimum} lovelace`);
      lastReported = total;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5_000));
  }
  throw new Error(`wallet funding timed out for ${address}`);
}

function resolveStatePath(
  configured: string | undefined,
  startStack: boolean,
): string {
  const statePath = resolve(configured ?? DEFAULT_STATE_FILE);
  const repoRoot = REPO_ROOT;
  const fromRepo = relative(repoRoot, statePath);
  if (fromRepo === "" || (!fromRepo.startsWith("../") && fromRepo !== "..")) {
    throw new Error("RESELLER_STATE_FILE must be outside the repository");
  }
  if (startStack && statePath !== DEFAULT_STATE_FILE) {
    throw new Error(
      `stack startup requires the fixed state file ${DEFAULT_STATE_FILE}`,
    );
  }
  return statePath;
}

async function readState(path: string): Promise<Record<string, string>> {
  let raw: string;
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error(`reseller state must be a regular file: ${path}`);
      }
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error(`reseller state is not owned by the current user: ${path}`);
      }
      if ((info.mode & 0o077) !== 0) {
        throw new Error(`reseller state permissions must be 0600: ${path}`);
      }
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const state: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (line === "" || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`invalid reseller state line: ${line}`);
    state[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return state;
}

async function writeState(path: string, state: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(state)) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`reseller state ${name} must be one line`);
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const body = Object.entries(state)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n";
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(body, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
  await chmod(path, 0o600);
}

function parseRef(value: string): OutputReference | null {
  const match = /^([0-9a-fA-F]{64})#(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  return { txHash: match[1], index: Number(match[2]) };
}

async function runCompose(composeFile: string): Promise<void> {
  const args = [
    "compose",
    "-f",
    resolve(REPO_ROOT, composeFile),
    "up",
    "-d",
    "--build",
    "--wait",
  ];
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn("docker", args, { stdio: "inherit" });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`docker compose exited with code ${code}`));
    });
  });
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  try {
    const result = await runResellerSetup(parseSetupArgs(argv), env);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`reseller setup failed: ${message}\n`);
    return 1;
  }
}

const invoked = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (invoked) {
  void main(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}
