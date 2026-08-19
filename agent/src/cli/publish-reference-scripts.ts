/**
 * publish-reference-scripts.ts — CLI entry point for
 *   `pnpm --filter @marketplace/supplier tx:publish-reference-scripts`.
 *
 * Publishes the escrow + advert validator scripts as CIP-33 reference UTxOs
 * at a known burn address (header 0x60 testnet / 0x61 mainnet, all-zero pkh).
 * After this tx confirms, set the printed refs in supplier/.env + buyer/.env:
 *   ESCROW_REF_UTXO=<txhash>#0
 *   ADVERT_REF_UTXO=<txhash>#1
 *
 * Reads env (no flags):
 *   SUPPLIER_PRIV_KEY_HEX     64-hex Ed25519 private key (also accepts buyer
 *                             key value if you want to fund publish from buyer
 *                             wallet — env name stays the same internally)
 *   OGMIOS_URL                https:// or wss:// endpoint (HTTPS preferred)
 *   NETWORK_ID                "0" (testnet) or "1" (mainnet)
 *   VECTOR_ZERO_TIME_MS       optional, mainnet override; defaults to testnet genesis
 *   ESCROW_PUBLISH_LOVELACE   optional, lovelace for the escrow output (default 30_000_000)
 *   ADVERT_PUBLISH_LOVELACE   optional, lovelace for the advert output (default 30_000_000)
 *
 * stdout (success):
 *   ESCROW_REF_UTXO=<txhash>#0
 *   ADVERT_REF_UTXO=<txhash>#1
 * stderr: progress lines.
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import {
  buildLiveTxForPublishReferenceScripts,
  loadEscrowScript,
  loadAdvertScript,
  pkhToEnterpriseAddress,
} from "@marketplace/shared/tx/server";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const HEX64_RE = /^[0-9a-f]{64}$/;
const ZERO_PKH_HEX = "0".repeat(56);

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

function deriveWalletKey(privHex: string, networkId: 0 | 1): WalletKey {
  const priv = hexToBytes(privHex);
  const pub = ed.getPublicKey(priv);
  const pubHex = bytesToHex(pub);
  const pkh = blake2b(pub, { dkLen: 28 });
  const pkhHex = bytesToHex(pkh);
  const header = networkId === 0 ? 0x60 : 0x61;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(pkh, 1);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  const addr = bech32.encode(hrp, bech32.toWords(payload), 1023);
  return {
    pubKeyHash: pkhHex,
    pubKeyHex: pubHex,
    privateKeyHex: privHex,
    address: addr,
  };
}

export async function main(env: Record<string, string | undefined>): Promise<number> {
  const privHex = (env.SUPPLIER_PRIV_KEY_HEX ?? "").toLowerCase();
  const ogmiosUrl = env.OGMIOS_URL ?? "";
  const networkIdStr = env.NETWORK_ID ?? "";

  if (!HEX64_RE.test(privHex)) {
    process.stderr.write("error: SUPPLIER_PRIV_KEY_HEX must be 64 lowercase hex chars\n");
    return 1;
  }
  if (!ogmiosUrl) {
    process.stderr.write("error: OGMIOS_URL is required\n");
    return 1;
  }
  if (networkIdStr !== "0" && networkIdStr !== "1") {
    process.stderr.write(`error: NETWORK_ID must be "0" or "1", got: ${networkIdStr}\n`);
    return 1;
  }
  const networkId: 0 | 1 = networkIdStr === "1" ? 1 : 0;

  let escrowLovelace: bigint | undefined;
  let advertLovelace: bigint | undefined;
  try {
    if (env.ESCROW_PUBLISH_LOVELACE) escrowLovelace = BigInt(env.ESCROW_PUBLISH_LOVELACE);
    if (env.ADVERT_PUBLISH_LOVELACE) advertLovelace = BigInt(env.ADVERT_PUBLISH_LOVELACE);
  } catch (err) {
    process.stderr.write(`error: *_PUBLISH_LOVELACE must be integer lovelace, got: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const walletKey = deriveWalletKey(privHex, networkId);
  const burnAddr = pkhToEnterpriseAddress(ZERO_PKH_HEX, networkId);
  const { script: escrowScript } = loadEscrowScript();
  const { script: advertScript } = loadAdvertScript();

  process.stderr.write(`wallet:    ${walletKey.address}\n`);
  process.stderr.write(`burn addr: ${burnAddr}\n`);
  process.stderr.write(`ogmios:    ${ogmiosUrl}\n`);
  process.stderr.write(`network:   ${networkId === 0 ? "testnet" : "mainnet"}\n`);
  process.stderr.write(`escrow lovelace: ${escrowLovelace ?? "30000000 (default)"}\n`);
  process.stderr.write(`advert lovelace: ${advertLovelace ?? "30000000 (default)"}\n`);

  const chain = new LiveOgmiosProvider({ ogmiosUrl });

  try {
    process.stderr.write(`building publish tx...\n`);
    const result = await buildLiveTxForPublishReferenceScripts({
      chain,
      walletKey,
      burnAddr,
      escrowScript,
      advertScript,
      escrowLovelace,
      advertLovelace,
    });
    process.stderr.write(`submitted: ${result.expectedTxHash}\n`);
    process.stdout.write(`ESCROW_REF_UTXO=${result.formattedEscrowRef}\n`);
    process.stdout.write(`ADVERT_REF_UTXO=${result.formattedAdvertRef}\n`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}

if (
  process.argv[1]?.endsWith("publish-reference-scripts.ts") ||
  process.argv[1]?.endsWith("publish-reference-scripts.js")
) {
  main(process.env).then((code) => process.exit(code));
}
