/**
 * consolidate-wallet.ts — CLI entry point for
 *   `pnpm --filter @marketplace/supplier tx:consolidate-wallet`.
 *
 * Re-shapes the supplier wallet to {collateral UTxO (default 5 AP3X),
 * working UTxO (remainder)} so subsequent script-spend txs (Claim/Submit/
 * Accept/RetireAdvert) find a pure-AP3X collateral candidate.
 *
 * Usage:
 *   pnpm --filter @marketplace/supplier tx:consolidate-wallet [--dry-run] \
 *     [--collateral-lovelace 5000000] [--await-timeout-ms 120000]
 *
 * Required env: SUPPLIER_PRIV_KEY_HEX, NETWORK_ID, OGMIOS_URL (when NETWORK_ID=1).
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { LiveOgmiosProvider, type ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { runConsolidateWallet } from "@marketplace/shared/tx/server";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

export type NetworkId = 0 | 1;

export interface CliConfig {
  ogmiosUrl: string;
  privKeyHex: string;
  networkId: NetworkId;
  collateralLovelace: bigint;
  awaitTimeoutMs: number;
  dryRun: boolean;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;
const DEFAULT_COLLATERAL_LOVELACE = 5_000_000;

const VALUE_FLAGS = new Set<string>([
  "--ogmios-url",
  "--priv-key",
  "--collateral-lovelace",
  "--await-timeout-ms",
]);
const BOOL_FLAGS = new Set<string>(["--dry-run"]);

function requireEnv(env: Record<string, string | undefined>, name: string): string {
  const v = env[name];
  if (v === undefined || v === null || v === "") {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
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
  collateralLovelace?: string;
  awaitTimeoutMs?: string;
  dryRun: boolean;
}

function parseRawArgv(argv: string[]): RawFlags {
  const out: RawFlags = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (BOOL_FLAGS.has(tok)) {
      if (tok === "--dry-run") out.dryRun = true;
      continue;
    }
    if (VALUE_FLAGS.has(tok)) {
      const val = argv[i + 1];
      if (val === undefined) throw new Error(`flag ${tok} requires a value`);
      switch (tok) {
        case "--ogmios-url":
          out.ogmiosUrl = val;
          break;
        case "--priv-key":
          out.privKey = val;
          break;
        case "--collateral-lovelace":
          out.collateralLovelace = val;
          break;
        case "--await-timeout-ms":
          out.awaitTimeoutMs = val;
          break;
      }
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${tok}`);
  }
  return out;
}

export function parseCliArgs(
  argv: string[],
  env: Record<string, string | undefined>,
): CliConfig {
  const flags = parseRawArgv(argv);

  const networkIdRaw = requireEnv(env, "NETWORK_ID");
  if (networkIdRaw !== "0" && networkIdRaw !== "1") {
    throw new Error(`NETWORK_ID must be "0" or "1", got: ${networkIdRaw}`);
  }
  const networkId: NetworkId = networkIdRaw === "1" ? 1 : 0;

  const privKeyHex = flags.privKey ?? requireEnv(env, "SUPPLIER_PRIV_KEY_HEX");
  if (!HEX64_RE.test(privKeyHex)) {
    throw new Error(
      "SUPPLIER_PRIV_KEY_HEX (or --priv-key) must be 64 lowercase hex chars",
    );
  }

  let ogmiosUrl: string;
  if (flags.ogmiosUrl !== undefined) {
    ogmiosUrl = flags.ogmiosUrl;
  } else if (env.OGMIOS_URL !== undefined && env.OGMIOS_URL !== "") {
    ogmiosUrl = env.OGMIOS_URL;
  } else if (networkId === 0) {
    ogmiosUrl = TESTNET_OGMIOS_DEFAULT;
  } else {
    throw new Error("OGMIOS_URL is required when NETWORK_ID=1");
  }

  const collateralLovelace = BigInt(
    flags.collateralLovelace === undefined
      ? DEFAULT_COLLATERAL_LOVELACE
      : parseIntStrict("--collateral-lovelace", flags.collateralLovelace),
  );

  const awaitTimeoutMs =
    flags.awaitTimeoutMs === undefined
      ? DEFAULT_AWAIT_TIMEOUT_MS
      : parseIntStrict("--await-timeout-ms", flags.awaitTimeoutMs);

  return {
    ogmiosUrl,
    privKeyHex,
    networkId,
    collateralLovelace,
    awaitTimeoutMs,
    dryRun: flags.dryRun,
  };
}

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

  const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });

  if (cfg.dryRun) {
    // Read-only pre-flight: query UTxOs and print the planned shape without
    // building or submitting a tx.
    try {
      const utxos = await chain.queryUtxosByAddress(walletKey.address);
      const total = utxos.reduce((acc, u) => acc + u.lovelace, 0n);
      process.stdout.write(
        `dry-run: wallet ${walletKey.address}\n` +
          `  ${utxos.length} UTxO(s), total ${total} lovelace\n` +
          `  target collateral: ${cfg.collateralLovelace}\n` +
          `  planned working:   ~${total - cfg.collateralLovelace - 2_000_000n} (after 2M fee reserve)\n`,
      );
      return 0;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`error: dry-run query failed: ${msg}\n`);
      return 1;
    }
  }

  try {
    const result = await runConsolidateWallet({
      chain,
      walletKey,
      collateralLovelace: cfg.collateralLovelace,
      awaitTimeoutMs: cfg.awaitTimeoutMs,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`REASON=${result.reason}\n`);
    if (result.txHash) {
      process.stdout.write(`TX_HASH=${result.txHash}\n`);
      process.stdout.write(`COLLATERAL_UTXO=${result.collateralRef}\n`);
      process.stdout.write(`WORKING_UTXO=${result.workingRef}\n`);
    }
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("consolidate-wallet.ts") ||
  process.argv[1]?.endsWith("consolidate-wallet.js")
) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`consolidate-wallet: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
