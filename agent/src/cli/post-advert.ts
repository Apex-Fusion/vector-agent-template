/**
 * post-advert.ts — CLI entry point for `pnpm --filter @marketplace/supplier tx:post-advert`.
 *
 * Exports:
 *   parseCliArgs(argv, env) — pure argument-parsing function, testable without spawning.
 *   main(argv, env)         — wires LiveOgmiosProvider (or MockChainProvider with
 *                             --mock), calls runPostAdvert, writes result to stdout.
 *
 * Argument parsing uses Node stdlib only (no commander / yargs).
 * Unknown flags throw.
 *
 * New advert (Part 2 §6.2, §9.2): --agent-id <64 hex> (default env AGENT_ID)
 * posts the advert with agent_id at the new advert address. The supplier key
 * needs a record first (tx:register-record); the flow refuses unless that
 * record lists the key with the transaction purpose and the capability. The
 * new advert needs IDENTITY_POLICY_ID (and IDENTITY_ADVERT_REF_UTXO on
 * mainnet). Without an agent id the CLI posts a legacy advert, which only
 * lists until the switch (§9.6).
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import {
  LiveOgmiosProvider,
  MockChainProvider,
  type ChainProvider,
} from "@marketplace/shared/chain";
import type { AdvertDatum, IdentityAdvertDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";
import { parseAgentId, supplierIdentity } from "../identity/agent.js";
import { runPostAdvert } from "./postAdvertFlow.js";
import { PAPER2AGENT_CAPABILITY_ID, PAPER2AGENT_DELIVERY_OVERHEAD_MS, PAPER2AGENT_SUPPLIER_OVERHEAD_MS,
  paper2AgentManifestHash, paper2AgentModel } from "@marketplace/shared/paper2agent";
import { readManifest } from "../paper2agent/local.js";

// Wire ed25519 sha512 hook (idempotent — matches buyer/src/index.ts).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

// ─── Types ───────────────────────────────────────────────────────────────

export type NetworkId = 0 | 1;

/**
 * CliConfig — the parsed, validated configuration produced by parseCliArgs.
 *
 * advertised_at is NOT set here — runPostAdvert fills it in from chain tip.
 */
export interface CliConfig {
  ogmiosUrl: string;
  privKeyHex: string;
  networkId: NetworkId;
  capabilityId: string;
  model: string;
  maxOutputTokens: number;
  maxProcessingMs: number;
  priceLovelace: bigint;
  supplierBondLovelace: bigint;
  buyerBondLovelace: bigint;
  endpointUrl: string;
  detailUri: string;
  detailHash: string;
  awaitTimeoutMs: number;
  dryRun: boolean;
  useMock: boolean;
  /** The record's agent for a new advert; undefined posts a legacy advert. */
  agentId?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const HEX64_RE = /^[0-9a-f]{64}$/;
const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
/** sha256("") — used as the default for ADVERT_DETAIL_HASH when absent/empty. */
const SHA256_EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const DEFAULT_BOND_LOVELACE = 1_000_000n;
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

// Flags that take a value (consume the next argv token).
const VALUE_FLAGS = new Set<string>([
  "--ogmios-url",
  "--priv-key",
  "--capability-id",
  "--model",
  "--max-output-tokens",
  "--max-processing-ms",
  "--price-lovelace",
  "--supplier-bond-lovelace",
  "--buyer-bond-lovelace",
  "--endpoint-url",
  "--detail-uri",
  "--detail-hash",
  "--await-timeout-ms",
  "--agent-id",
]);

// Boolean flags (presence = true; no value follows).
const BOOL_FLAGS = new Set<string>(["--dry-run", "--mock"]);

// ─── Helpers ─────────────────────────────────────────────────────────────

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function parseBigIntStrict(name: string, raw: string): bigint {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be a numeric integer (got: ${raw})`);
  }
  try {
    return BigInt(raw);
  } catch {
    throw new Error(`${name} must be a numeric integer (got: ${raw})`);
  }
}

function parseIntStrict(name: string, raw: string): number {
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer (got: ${raw})`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`${name} must be an integer (got: ${raw})`);
  }
  return n;
}

interface RawFlags {
  ogmiosUrl?: string;
  privKey?: string;
  capabilityId?: string;
  model?: string;
  maxOutputTokens?: string;
  maxProcessingMs?: string;
  priceLovelace?: string;
  supplierBondLovelace?: string;
  buyerBondLovelace?: string;
  endpointUrl?: string;
  detailUri?: string;
  detailHash?: string;
  awaitTimeoutMs?: string;
  agentId?: string;
  dryRun: boolean;
  useMock: boolean;
}

function parseRawArgv(argv: string[]): RawFlags {
  const out: RawFlags = { dryRun: false, useMock: false };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (BOOL_FLAGS.has(tok)) {
      if (tok === "--dry-run") out.dryRun = true;
      else if (tok === "--mock") out.useMock = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) {
        throw new Error(`flag ${tok} requires a value`);
      }
      switch (tok) {
        case "--ogmios-url":
          out.ogmiosUrl = val;
          break;
        case "--priv-key":
          out.privKey = val;
          break;
        case "--capability-id":
          out.capabilityId = val;
          break;
        case "--model":
          out.model = val;
          break;
        case "--max-output-tokens":
          out.maxOutputTokens = val;
          break;
        case "--max-processing-ms":
          out.maxProcessingMs = val;
          break;
        case "--price-lovelace":
          out.priceLovelace = val;
          break;
        case "--supplier-bond-lovelace":
          out.supplierBondLovelace = val;
          break;
        case "--buyer-bond-lovelace":
          out.buyerBondLovelace = val;
          break;
        case "--endpoint-url":
          out.endpointUrl = val;
          break;
        case "--detail-uri":
          out.detailUri = val;
          break;
        case "--detail-hash":
          out.detailHash = val;
          break;
        case "--await-timeout-ms":
          out.awaitTimeoutMs = val;
          break;
        case "--agent-id":
          out.agentId = val;
          break;
      }
      i++; // consume the value
      continue;
    }
    // Anything starting with -- that we did not recognise is an error.
    if (tok.startsWith("--")) {
      throw new Error(`unknown flag: ${tok}`);
    }
    throw new Error(`unknown flag: ${tok}`);
  }

  return out;
}

// ─── parseCliArgs ────────────────────────────────────────────────────────

/**
 * parseCliArgs — pure: argv (process.argv.slice(2)) + env map → CliConfig.
 *
 * Rules:
 *   - Unknown flags throw Error("unknown flag: <flag>").
 *   - Missing required env vars throw Error naming the missing var.
 *   - ADVERT_PRICE_LOVELACE non-numeric → throws.
 *   - NETWORK_ID not "0" or "1" → throws.
 *   - --priv-key / SUPPLIER_PRIV_KEY_HEX must be 64 hex chars.
 *   - ADVERT_DETAIL_HASH absent/empty → defaults to sha256("").
 *   - OGMIOS_URL absent with NETWORK_ID="0" → defaults to the public
 *     Vector testnet Ogmios. Absent with NETWORK_ID="1" → throws (no
 *     public mainnet default).
 */
export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): CliConfig {
  const flags = parseRawArgv(argv);
  const toolManifest = env.CAPABILITY_KIND === "paper2agent"
    ? readManifest(requireEnv(env, "PAPER2AGENT_MANIFEST"))
    : undefined;

  // ── networkId ──
  const networkIdRaw = requireEnv(env, "NETWORK_ID");
  if (networkIdRaw !== "0" && networkIdRaw !== "1") {
    throw new Error(
      `NETWORK_ID must be "0" (testnet) or "1" (mainnet), got: ${networkIdRaw}`,
    );
  }
  const networkId: NetworkId = networkIdRaw === "1" ? 1 : 0;

  // ── privKeyHex (env required; flag overrides) ──
  const privKeyHex = flags.privKey ?? requireEnv(env, "SUPPLIER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(privKeyHex)) {
    throw new Error(
      "SUPPLIER_PRIV_KEY_HEX (or --priv-key) must be 64 lowercase hex chars",
    );
  }

  // ── ogmiosUrl ──
  let ogmiosUrl: string;
  if (flags.ogmiosUrl !== undefined) {
    ogmiosUrl = flags.ogmiosUrl;
  } else if (env.OGMIOS_URL !== undefined && env.OGMIOS_URL !== "") {
    ogmiosUrl = env.OGMIOS_URL;
  } else if (networkId === 0) {
    ogmiosUrl = TESTNET_OGMIOS_DEFAULT;
  } else {
    throw new Error(
      "OGMIOS_URL is required when NETWORK_ID=1 (no public mainnet default)",
    );
  }

  // ── advert env required ──
  // An empty variable is absent. Only a Paper2Agent manifest supplies defaults.
  const advertEnv = (name: string, toolDefault: string | undefined): string =>
    env[name] || toolDefault || requireEnv(env, name);
  const capabilityId = flags.capabilityId ??
    advertEnv("ADVERT_CAPABILITY_ID", toolManifest && PAPER2AGENT_CAPABILITY_ID);
  const model = flags.model ?? advertEnv("ADVERT_MODEL", toolManifest && paper2AgentModel(toolManifest));

  const maxOutputTokensRaw = flags.maxOutputTokens ??
    advertEnv("ADVERT_MAX_OUTPUT_TOKENS", toolManifest && "0");
  const maxOutputTokens = parseIntStrict(
    "ADVERT_MAX_OUTPUT_TOKENS",
    maxOutputTokensRaw,
  );

  // The default also covers the buyer's Post confirmation wait. A shorter
  // explicit value stays valid while it keeps the supplier's own reserve.
  const maxProcessingMsRaw = flags.maxProcessingMs ?? advertEnv("ADVERT_MAX_PROCESSING_MS",
    toolManifest && String(toolManifest.limits.max_runtime_ms + PAPER2AGENT_DELIVERY_OVERHEAD_MS));
  const maxProcessingMs = parseIntStrict(
    "ADVERT_MAX_PROCESSING_MS",
    maxProcessingMsRaw,
  );
  if (toolManifest && (capabilityId !== PAPER2AGENT_CAPABILITY_ID ||
      model !== paper2AgentModel(toolManifest) || maxOutputTokens !== 0 ||
      maxProcessingMs < toolManifest.limits.max_runtime_ms + PAPER2AGENT_SUPPLIER_OVERHEAD_MS)) {
    throw new Error("Paper2Agent advert must match the manifest and include chain lifecycle time");
  }

  const priceLovelaceRaw =
    flags.priceLovelace ?? requireEnv(env, "ADVERT_PRICE_LOVELACE");
  const priceLovelace = parseBigIntStrict(
    "ADVERT_PRICE_LOVELACE",
    priceLovelaceRaw,
  );

  // Bond defaults: 1_000_000n.
  const supplierBondRaw =
    flags.supplierBondLovelace ?? env.ADVERT_SUPPLIER_BOND_LOVELACE;
  const supplierBondLovelace =
    supplierBondRaw === undefined || supplierBondRaw === ""
      ? DEFAULT_BOND_LOVELACE
      : parseBigIntStrict("ADVERT_SUPPLIER_BOND_LOVELACE", supplierBondRaw);

  const buyerBondRaw = flags.buyerBondLovelace ?? env.ADVERT_BUYER_BOND_LOVELACE;
  const buyerBondLovelace =
    buyerBondRaw === undefined || buyerBondRaw === ""
      ? DEFAULT_BOND_LOVELACE
      : parseBigIntStrict("ADVERT_BUYER_BOND_LOVELACE", buyerBondRaw);

  // ── endpointUrl required ──
  const endpointUrl = flags.endpointUrl ?? requireEnv(env, "ADVERT_ENDPOINT_URL");

  // ── detailUri / detailHash optional ──
  const detailUri =
    flags.detailUri ?? (env.ADVERT_DETAIL_URI !== undefined ? env.ADVERT_DETAIL_URI : "");

  const detailHashRaw =
    flags.detailHash !== undefined
      ? flags.detailHash
      : env.ADVERT_DETAIL_HASH !== undefined
        ? env.ADVERT_DETAIL_HASH
        : "";
  const detailHash = detailHashRaw === ""
    ? (toolManifest ? paper2AgentManifestHash(toolManifest) : SHA256_EMPTY)
    : detailHashRaw;

  // ── awaitTimeoutMs ──
  const awaitTimeoutMs =
    flags.awaitTimeoutMs === undefined
      ? DEFAULT_AWAIT_TIMEOUT_MS
      : parseIntStrict("--await-timeout-ms", flags.awaitTimeoutMs);

  // ── agentId (new advert; flag overrides env AGENT_ID) ──
  const agentId = parseAgentId(flags.agentId ?? env.AGENT_ID, "--agent-id / AGENT_ID");

  return {
    ogmiosUrl,
    privKeyHex,
    networkId,
    capabilityId,
    model,
    maxOutputTokens,
    maxProcessingMs,
    priceLovelace,
    supplierBondLovelace,
    buyerBondLovelace,
    endpointUrl,
    detailUri,
    detailHash,
    awaitTimeoutMs,
    agentId,
    dryRun: flags.dryRun,
    useMock: flags.useMock,
  };
}

// ─── Wallet derivation (matches buyer/src/index.ts) ──────────────────────

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function deriveWalletKey(privHex: string, networkId: NetworkId): WalletKey {
  const priv = hexToBytes(privHex);
  const pub = ed.getPublicKey(priv);
  const pubHex = bytesToHex(pub);
  const pkh = blake2b(pub, { dkLen: 28 });
  const pkhHex = bytesToHex(pkh);
  const header = networkId === 0 ? 0x60 : 0x61;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(pkh, 1);
  const words = bech32.toWords(payload);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  const addr = bech32.encode(hrp, words, 1023);
  return {
    pubKeyHash: pkhHex,
    pubKeyHex: pubHex,
    privateKeyHex: privHex,
    address: addr,
  };
}

// ─── main ────────────────────────────────────────────────────────────────

/**
 * main — CLI entry point.
 *
 * Success: prints "<txHash>#0\n" to stdout. All progress lines go to stderr.
 * Failure: prints "error: <message>\n" to stderr; the caller decides exit code.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let cfg: CliConfig;
  try {
    cfg = parseCliArgs(argv, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  let walletKey: WalletKey;
  try {
    walletKey = deriveWalletKey(cfg.privKeyHex, cfg.networkId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: wallet derivation failed: ${msg}\n`);
    return 1;
  }

  const legacyDatum: AdvertDatum = {
    supplier_pkh: walletKey.pubKeyHash,
    capability_id: cfg.capabilityId,
    model: cfg.model,
    max_output_tokens: cfg.maxOutputTokens,
    max_processing_ms: cfg.maxProcessingMs,
    price_lovelace: cfg.priceLovelace,
    supplier_bond_lovelace: cfg.supplierBondLovelace,
    buyer_bond_lovelace: cfg.buyerBondLovelace,
    endpoint_url: cfg.endpointUrl,
    detail_uri: cfg.detailUri,
    detail_hash: cfg.detailHash,
    advertised_at: 0, // overridden by runPostAdvert from chain tip
    status: "Active",
  };
  const advertDatum: AdvertDatum | IdentityAdvertDatum = cfg.agentId === undefined
    ? legacyDatum
    : { ...legacyDatum, agent_id: cfg.agentId };

  const chain: ChainProvider = cfg.useMock
    ? new MockChainProvider()
    : new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });

  if (cfg.dryRun) {
    process.stdout.write(
      `dry-run: advertDatum=${JSON.stringify(advertDatum, (_k, v) =>
        typeof v === "bigint" ? `${v.toString()}n` : v,
      )}\n`,
    );
    return 0;
  }

  try {
    const result = await runPostAdvert({
      chain,
      walletKey,
      advertDatum,
      awaitTimeoutMs: cfg.awaitTimeoutMs,
      log: (line) => process.stderr.write(`${line}\n`),
      identity: cfg.agentId === undefined ? undefined : supplierIdentity(chain, cfg.networkId),
    });
    process.stdout.write(`${result.formattedRef}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

// Auto-invoke when run directly (tsx src/cli/post-advert.ts).
if (
  process.argv[1]?.endsWith("post-advert.ts") ||
  process.argv[1]?.endsWith("post-advert.js")
) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`post-advert: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
