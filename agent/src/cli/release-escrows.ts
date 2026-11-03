/**
 * release-escrows.ts — CLI entry point for
 *   `pnpm --filter @marketplace/supplier tx:release-escrows`.
 *
 * Finds this supplier's Submitted escrows by scanning the escrow script
 * addresses on chain, verifies each is past the buyer's accept window, then
 * releases them serially (supplier receives payment + both bonds). During
 * the drain (Part 2 §9.6) it scans both escrow addresses: the legacy escrow
 * and, when IDENTITY_POLICY_ID is set, the new escrow.
 *
 * Discovery deliberately does NOT use the indexer: it misses Submit
 * transitions under load (2026-09: four Submitted strays of the OCR supplier
 * were on chain but absent from /escrows?supplier=), and the indexer never
 * updates rows on terminal spends. The chain is the source of truth and the
 * whole address (~4k UTxOs on mainnet) reads in about a second.
 *
 * Usage:
 *   pnpm --filter @marketplace/supplier tx:release-escrows [--dry-run] \
 *     [--ref <txHash>#<index>] [--limit N] [--await-timeout-ms 120000]
 *
 * Required env: SUPPLIER_PRIV_KEY_HEX, NETWORK_ID, OGMIOS_URL (when
 * NETWORK_ID=1). Mainnet live builds also require ESCROW_REF_UTXO and
 * VECTOR_ZERO_TIME_MS through the shared transaction builder. New escrows
 * need IDENTITY_POLICY_ID (and IDENTITY_ESCROW_REF_UTXO on mainnet).
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import {
  LiveOgmiosProvider,
  type ChainProvider,
  type OutputReference,
} from "@marketplace/shared/chain";
import { decodeEscrow } from "../identity/agent.js";
import {
  ACCEPT_WINDOW_MS,
  buildReleaseTx,
  loadBlueprint,
  loadIdentityBlueprint,
  TxConstructionError,
  type WalletKey,
} from "@marketplace/shared/tx";

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
  refs: OutputReference[];
  limit: number;
  awaitTimeoutMs: number;
  dryRun: boolean;
}

export interface ReleaseEscrowsConfig {
  /** Escrow script addresses to scan when no explicit --ref is given (legacy and new). */
  escrowAddresses: string[];
  supplierKey: WalletKey;
  refs: OutputReference[];
  limit: number;
  awaitTimeoutMs: number;
  dryRun: boolean;
}

export interface ReleaseEscrowsDeps {
  chain: ChainProvider;
  now: () => number;
}

export interface ReleaseEscrowsResult {
  released: number;
  skipped: number;
  failed: number;
  exitCode: 0 | 1;
}

const HEX64_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^([0-9a-f]{64})#(0|[1-9]\d*)$/;
const TESTNET_OGMIOS_DEFAULT = "https://ogmios.vector.testnet.apexfusion.org";
const DEFAULT_AWAIT_TIMEOUT_MS = 120_000;

const VALUE_FLAGS: Record<string, true> = {
  "--ref": true,
  "--limit": true,
  "--await-timeout-ms": true,
  "--ogmios-url": true,
  "--priv-key": true,
};
const BOOL_FLAGS: Record<string, true> = { "--dry-run": true };

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

function parseRef(raw: string): OutputReference {
  const match = REF_RE.exec(raw);
  if (!match) {
    throw new Error(`--ref must be <64-char lowercase tx hash>#<index> (got: ${raw})`);
  }
  const index = Number(match[2]);
  if (!Number.isSafeInteger(index)) {
    throw new Error(`--ref index must be a safe integer (got: ${match[2]})`);
  }
  return { txHash: match[1], index };
}

interface RawFlags {
  ogmiosUrl?: string;
  privKey?: string;
  refs: string[];
  limit?: string;
  awaitTimeoutMs?: string;
  dryRun: boolean;
}

function parseRawArgv(argv: string[]): RawFlags {
  const out: RawFlags = { refs: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (BOOL_FLAGS[tok] === true) {
      if (tok === "--dry-run") out.dryRun = true;
      continue;
    }
    if (VALUE_FLAGS[tok] === true) {
      const val = argv[i + 1];
      if (val === undefined) throw new Error(`flag ${tok} requires a value`);
      switch (tok) {
        case "--ref":
          out.refs.push(val);
          break;
        case "--limit":
          out.limit = val;
          break;
        case "--await-timeout-ms":
          out.awaitTimeoutMs = val;
          break;
        case "--ogmios-url":
          out.ogmiosUrl = val;
          break;
        case "--priv-key":
          out.privKey = val;
          break;
      }
      i++;
      continue;
    }
    throw new Error(`unknown flag: ${tok}`);
  }
  return out;
}

export function parseArgs(
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

  const limit =
    flags.limit === undefined
      ? Number.POSITIVE_INFINITY
      : parseIntStrict("--limit", flags.limit);
  if (limit < 0) throw new Error("--limit must be non-negative");

  const awaitTimeoutMs =
    flags.awaitTimeoutMs === undefined
      ? DEFAULT_AWAIT_TIMEOUT_MS
      : parseIntStrict("--await-timeout-ms", flags.awaitTimeoutMs);
  if (awaitTimeoutMs <= 0) {
    throw new Error("--await-timeout-ms must be positive");
  }

  return {
    ogmiosUrl,
    privKeyHex,
    networkId,
    refs: flags.refs.map(parseRef),
    limit,
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

function formatRef(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}

/** Submitted escrows addressed to this supplier, from a full scan of the
 * script addresses. Explicit --ref values bypass the scan (still verified). */
async function discoverRefs(
  cfg: ReleaseEscrowsConfig,
  chain: ChainProvider,
): Promise<OutputReference[]> {
  if (cfg.refs.length > 0) return cfg.refs;

  const refs: OutputReference[] = [];
  for (const address of cfg.escrowAddresses) {
    for (const utxo of await chain.queryUtxosByAddress(address)) {
      if (!utxo.datumHex) continue;
      let datum;
      try {
        datum = decodeEscrow(utxo.datumHex).datum;
      } catch {
        continue; // foreign or malformed datum at the script address
      }
      if (datum.state === "Submitted" && datum.supplier_pkh === cfg.supplierKey.pubKeyHash) {
        refs.push(utxo.ref);
      }
    }
  }
  return refs;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runReleaseEscrows(
  cfg: ReleaseEscrowsConfig,
  deps: ReleaseEscrowsDeps,
): Promise<ReleaseEscrowsResult> {
  const refs = await discoverRefs(cfg, deps.chain);
  let released = 0;
  let skipped = 0;
  let failed = 0;
  let releaseSlotsUsed = 0;

  for (const escrowRef of refs) {
    if (releaseSlotsUsed >= cfg.limit) break;

    const ref = formatRef(escrowRef);
    try {
      const utxo = await deps.chain.queryUtxo(escrowRef);
      if (utxo === null) {
        process.stdout.write(`skip ${ref} already-spent\n`);
        skipped++;
        continue;
      }
      if (utxo.datumHex === null) {
        throw new Error("escrow UTxO has no inline datum");
      }

      const datum = decodeEscrow(utxo.datumHex).datum;
      if (datum.state !== "Submitted") {
        process.stdout.write(`skip ${ref} state=${datum.state}\n`);
        skipped++;
        continue;
      }
      if (datum.submitted_at === null) {
        process.stdout.write(`skip ${ref} submitted_at missing\n`);
        skipped++;
        continue;
      }

      const releasableAt = datum.submitted_at + ACCEPT_WINDOW_MS;
      if (deps.now() < releasableAt) {
        process.stdout.write(
          `skip ${ref} window-open (releasable at ${new Date(releasableAt).toISOString()})\n`,
        );
        skipped++;
        continue;
      }

      const payout =
        datum.payment_lovelace +
        datum.buyer_bond_lovelace +
        datum.supplier_bond_lovelace;
      if (cfg.dryRun) {
        process.stdout.write(`dry-run ${ref} payout=${payout}\n`);
        releaseSlotsUsed++;
        continue;
      }

      let built;
      try {
        built = await buildReleaseTx({
          chain: deps.chain,
          supplierKey: cfg.supplierKey,
          escrowRef,
        });
      } catch (err) {
        if (err instanceof TxConstructionError) {
          process.stdout.write(`skip ${ref} ${err.reason}: ${err.message}\n`);
          skipped++;
          continue;
        }
        throw err;
      }

      // The builder has submitted the transaction, so this release consumes a
      // limit slot even if confirmation later times out.
      releaseSlotsUsed++;
      await deps.chain.awaitTx(built.expectedTxHash, cfg.awaitTimeoutMs);
      process.stdout.write(
        `released ${ref} payout=${payout} tx=${built.expectedTxHash}\n`,
      );
      released++;
    } catch (err) {
      process.stdout.write(`failed ${ref} ${errorMessage(err)}\n`);
      failed++;
    }
  }

  process.stdout.write(`released=${released} skipped=${skipped} failed=${failed}\n`);
  return { released, skipped, failed, exitCode: failed > 0 ? 1 : 0 };
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
): Promise<number> {
  let cfg: CliConfig;
  try {
    cfg = parseArgs(argv, env);
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    return 1;
  }

  let supplierKey: WalletKey;
  try {
    supplierKey = deriveWalletKey(cfg.privKeyHex, cfg.networkId);
  } catch (err) {
    process.stderr.write(`error: wallet derivation failed: ${errorMessage(err)}\n`);
    return 1;
  }

  const chain: ChainProvider = new LiveOgmiosProvider({ ogmiosUrl: cfg.ogmiosUrl });
  const escrowAddresses = [loadBlueprint().escrowScriptAddress(cfg.networkId)];
  try {
    escrowAddresses.push(loadIdentityBlueprint().escrowScriptAddress(cfg.networkId));
  } catch (err) {
    process.stderr.write(`note: scanning the legacy escrow address only (${errorMessage(err)})\n`);
  }
  try {
    const result = await runReleaseEscrows(
      {
        escrowAddresses,
        supplierKey,
        refs: cfg.refs,
        limit: cfg.limit,
        awaitTimeoutMs: cfg.awaitTimeoutMs,
        dryRun: cfg.dryRun,
      },
      { chain, now: Date.now },
    );
    return result.exitCode;
  } catch (err) {
    process.stderr.write(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("release-escrows.ts") ||
  process.argv[1]?.endsWith("release-escrows.js")
) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`release-escrows: fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
