/**
 * gen-keypair.ts — CLI entry point for `pnpm --filter @marketplace/supplier tx:gen-keypair`.
 *
 * Generates a fresh Ed25519 keypair and derives the corresponding Cardano
 * enterprise address. Useful for bootstrapping a new supplier wallet without
 * the friction of `openssl rand -hex 32` + `tx:post-advert --dry-run` to
 * read back the derived address.
 *
 * Usage:
 *   pnpm --filter @marketplace/supplier tx:gen-keypair --network 1
 *
 * Args:
 *   --network <0|1>   testnet (0, default) or mainnet (1)
 *   --priv-key <hex>  use the provided 64-hex private key instead of generating
 *
 * Output (stdout, JSON, suitable for piping into jq):
 *   {
 *     "privateKeyHex": "<64 hex>",
 *     "publicKeyHex":  "<64 hex>",
 *     "pubKeyHash":    "<56 hex>",   // blake2b-224 of pubKey
 *     "address":       "addr1..." | "addr_test1..."
 *   }
 *
 * Wallet derivation mirrors post-advert.ts:359-378 so the address produced
 * here matches what the supplier itself will derive at boot.
 */

import { createHash, randomBytes } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";

// Wire ed25519 sha512 hook (idempotent — matches post-advert.ts).
ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

export type NetworkId = 0 | 1;

export interface DerivedKeypair {
  privateKeyHex: string;
  publicKeyHex: string;
  pubKeyHash: string;
  address: string;
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

export function deriveKeypair(privHex: string, networkId: NetworkId): DerivedKeypair {
  if (!HEX64_RE.test(privHex)) {
    throw new Error("priv-key must be 64 hex chars (32 bytes)");
  }
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
  const address = bech32.encode(hrp, words, 1023);
  return {
    privateKeyHex: privHex.toLowerCase(),
    publicKeyHex: pubHex,
    pubKeyHash: pkhHex,
    address,
  };
}

export interface CliArgs {
  networkId: NetworkId;
  privKeyHex: string | null;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let networkId: NetworkId = 0;
  let privKeyHex: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--network") {
      const v = argv[++i];
      if (v !== "0" && v !== "1") throw new Error('--network must be "0" or "1"');
      networkId = v === "1" ? 1 : 0;
    } else if (arg === "--priv-key") {
      const v = argv[++i];
      if (!v || !HEX64_RE.test(v)) throw new Error("--priv-key must be 64 hex chars (32 bytes)");
      privKeyHex = v.toLowerCase();
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(
        "usage: tx:gen-keypair [--network 0|1] [--priv-key <64-hex>]",
      );
    } else {
      throw new Error(`unknown flag: ${arg}`);
    }
  }
  return { networkId, privKeyHex };
}

export function main(argv: string[]): number {
  let args: CliArgs;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  const privHex = args.privKeyHex ?? bytesToHex(new Uint8Array(randomBytes(32)));
  let derived: DerivedKeypair;
  try {
    derived = deriveKeypair(privHex, args.networkId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }

  process.stdout.write(JSON.stringify(derived, null, 2) + "\n");
  return 0;
}

// Run when invoked directly (tsx supplier/src/cli/gen-keypair.ts ...)
const invoked = process.argv[1] ?? "";
if (invoked.endsWith("gen-keypair.ts") || invoked.endsWith("gen-keypair.js")) {
  const code = main(process.argv.slice(2));
  process.exit(code);
}
