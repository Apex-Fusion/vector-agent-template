/**
 * retire-advert.ts — CLI entry point for `pnpm --filter @marketplace/supplier tx:retire-advert`.
 *
 * Spends an advert UTxO (named via --advert-ref or ADVERT_REF env), returning
 * the locked bond to the supplier wallet. Validator: contracts/marketplace/
 * validators/advert.ak handle_retire — requires supplier signature and at
 * least one output to the supplier's vkh address.
 *
 * Usage:
 *   pnpm --filter @marketplace/supplier tx:retire-advert \
 *     --advert-ref <txhash>#<index>
 *
 * Required env: SUPPLIER_PRIV_KEY_HEX, NETWORK_ID.
 * Optional env: OGMIOS_URL (defaults to Vector testnet for NETWORK_ID=0),
 *               ADVERT_REF (alternative to --advert-ref).
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import {
  LiveOgmiosProvider,
  MockChainProvider,
  type ChainProvider,
  type OutputReference,
} from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { runRetireAdvert } from "./retireAdvertFlow.js";

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
  advertRef: OutputReference;
  awaitTimeoutMs: number;
  dryRun: boolean;
  useMock: boolean;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const ADVERT_REF_RE = /^([0-9a-f]{64})#(\d+)$/;
const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

const VALUE_FLAGS = new Set<string>([
  "--ogmios-url",
  "--priv-key",
  "--advert-ref",
  "--await-timeout-ms",
]);
const BOOL_FLAGS = new Set<string>(["--dry-run", "--mock"]);

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

function parseAdvertRef(name: string, raw: string): OutputReference {
  const m = ADVERT_REF_RE.exec(raw);
  if (!m) {
    throw new Error(
      `${name} must be <64-hex-txhash>#<index> (got: ${raw})`,
    );
  }
  return { txHash: m[1], index: Number(m[2]) };
}

interface RawFlags {
  ogmiosUrl?: string;
  privKey?: string;
  advertRef?: string;
  awaitTimeoutMs?: string;
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
      if (val === undefined) throw new Error(`flag ${tok} requires a value`);
      switch (tok) {
        case "--ogmios-url": out.ogmiosUrl = val; break;
        case "--priv-key": out.privKey = val; break;
        case "--advert-ref": out.advertRef = val; break;
        case "--await-timeout-ms": out.awaitTimeoutMs = val; break;
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
    throw new Error("SUPPLIER_PRIV_KEY_HEX (or --priv-key) must be 64 lowercase hex chars");
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

  const advertRefRaw = flags.advertRef ?? env.ADVERT_REF;
  if (advertRefRaw === undefined || advertRefRaw === "") {
    throw new Error(
      "advert ref required: pass --advert-ref <txhash>#<index> or set ADVERT_REF",
    );
  }
  const advertRef = parseAdvertRef("--advert-ref", advertRefRaw);

  const awaitTimeoutMs =
    flags.awaitTimeoutMs === undefined
      ? DEFAULT_AWAIT_TIMEOUT_MS
      : parseIntStrict("--await-timeout-ms", flags.awaitTimeoutMs);

  return {
    ogmiosUrl,
    privKeyHex,
    networkId,
    advertRef,
    awaitTimeoutMs,
    dryRun: flags.dryRun,
    useMock: flags.useMock,
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

  const chain: ChainProvider = cfg.useMock
    ? new MockChainProvider()
    : new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });

  if (cfg.dryRun) {
    process.stdout.write(
      `dry-run: would retire advert ${cfg.advertRef.txHash}#${cfg.advertRef.index} ` +
        `as supplier ${walletKey.pubKeyHash} (${walletKey.address})\n`,
    );
    return 0;
  }

  try {
    const result = await runRetireAdvert({
      chain,
      walletKey,
      advertRef: cfg.advertRef,
      awaitTimeoutMs: cfg.awaitTimeoutMs,
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${result.formattedRef}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("retire-advert.ts") ||
  process.argv[1]?.endsWith("retire-advert.js")
) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`retire-advert: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
