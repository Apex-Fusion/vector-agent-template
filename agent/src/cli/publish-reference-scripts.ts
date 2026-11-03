/**
 * publish-reference-scripts.ts — CLI entry point for
 *   `pnpm --filter @marketplace/supplier tx:publish-reference-scripts [--legacy]`.
 *
 * Publishes the escrow + advert validator scripts as CIP-33 reference UTxOs in
 * one transaction, with the shared publisher (buildPublishReferenceScripts of
 * @marketplace/shared/tx/server). The outputs go to its default address: the
 * enterprise address of the all-zero key hash, which nobody can spend.
 *
 * Default: the new escrow and advert (Part 2 §6.1, §6.2, §9.6 step 1). The
 * escrow script has IDENTITY_POLICY_ID applied, so its hash is the deployed
 * hash. After this tx confirms, set the printed refs in the supplier, buyer
 * and gateway env:
 *   IDENTITY_ESCROW_REF_UTXO=<txhash>#0
 *   IDENTITY_ADVERT_REF_UTXO=<txhash>#1
 * --legacy: the legacy escrow and advert, as before the identity release:
 *   ESCROW_REF_UTXO=<txhash>#0
 *   ADVERT_REF_UTXO=<txhash>#1
 * Spenders keep both pairs until the drain ends.
 *
 * Reads env:
 *   SUPPLIER_PRIV_KEY_HEX     64-hex Ed25519 private key (also accepts buyer
 *                             key value if you want to fund publish from buyer
 *                             wallet — env name stays the same internally)
 *   OGMIOS_URL                https:// endpoint (protocol parameters, wallet
 *                             UTxOs and submission)
 *   NETWORK_ID                "0" (testnet) or "1" (mainnet)
 *   IDENTITY_POLICY_ID        56-hex identity hash (the new escrow's parameter);
 *                             required without --legacy
 *   VECTOR_ZERO_TIME_MS       the testnet system start in ms; required on
 *                             NETWORK_ID=0 (the validity interval needs the slot clock)
 *   ESCROW_PUBLISH_LOVELACE   optional, lovelace for the escrow output (default: the ledger minimum)
 *   ADVERT_PUBLISH_LOVELACE   optional, lovelace for the advert output (default: the ledger minimum)
 *
 * stdout (success): the two env lines above.
 * stderr: progress lines, including both script hashes, the fee and the
 * AP3X of each reference output.
 */

import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { signTransaction, validityWindow } from "@marketplace/shared";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import { loadBlueprint, loadIdentityBlueprint, type WalletKey } from "@marketplace/shared/tx";
import {
  buildPublishReferenceScripts,
  loadEscrowScript,
  loadAdvertScript,
  loadIdentityAdvertScript,
  loadIdentityEscrowScript,
  referenceScriptAddress,
} from "@marketplace/shared/tx/server";
import { ogmiosProtocolParameters, vectorSlotConfig } from "../identity/registrar.js";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const HEX64_RE = /^[0-9a-f]{64}$/;

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

/** The pair to publish: output #0 is the escrow, output #1 the advert. */
export interface ReferenceScriptSet {
  escrowEnv: "IDENTITY_ESCROW_REF_UTXO" | "ESCROW_REF_UTXO";
  advertEnv: "IDENTITY_ADVERT_REF_UTXO" | "ADVERT_REF_UTXO";
  /** CIP-57 compiled code and script hash of each script. */
  escrow: { compiledCode: string; hash: string };
  advert: { compiledCode: string; hash: string };
}

/**
 * The new pair (identity hash from env IDENTITY_POLICY_ID applied to the
 * escrow), or the legacy pair with --legacy. Throws on another argument or
 * a missing identity hash.
 */
export function referenceScriptSet(argv: string[], env: Record<string, string | undefined>): ReferenceScriptSet {
  const unknown = argv.find((arg) => arg !== "--legacy");
  if (unknown !== undefined) throw new Error(`unknown flag: ${unknown}`);
  if (argv.includes("--legacy")) {
    const blueprint = loadBlueprint();
    return {
      escrowEnv: "ESCROW_REF_UTXO",
      advertEnv: "ADVERT_REF_UTXO",
      escrow: { compiledCode: loadEscrowScript().script.script, hash: blueprint.escrowScriptHash },
      advert: { compiledCode: loadAdvertScript().script.script, hash: blueprint.advertScriptHash },
    };
  }
  const blueprint = loadIdentityBlueprint({ identityHash: env.IDENTITY_POLICY_ID ?? "" });
  const escrow = loadIdentityEscrowScript(blueprint);
  const advert = loadIdentityAdvertScript(blueprint);
  return {
    escrowEnv: "IDENTITY_ESCROW_REF_UTXO",
    advertEnv: "IDENTITY_ADVERT_REF_UTXO",
    escrow: { compiledCode: escrow.script.script, hash: escrow.hash },
    advert: { compiledCode: advert.script.script, hash: advert.hash },
  };
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<number> {
  let scripts: ReferenceScriptSet;
  try {
    scripts = referenceScriptSet(argv, env);
  } catch (err) {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
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

  process.stderr.write(`wallet:    ${walletKey.address}\n`);
  process.stderr.write(`burn addr: ${referenceScriptAddress(networkId)}\n`);
  process.stderr.write(`ogmios:    ${ogmiosUrl}\n`);
  process.stderr.write(`network:   ${networkId === 0 ? "testnet" : "mainnet"}\n`);
  process.stderr.write(`escrow script hash: ${scripts.escrow.hash} (output #0, ${scripts.escrowEnv})\n`);
  process.stderr.write(`advert script hash: ${scripts.advert.hash} (output #1, ${scripts.advertEnv})\n`);

  const chain = new LiveOgmiosProvider({ ogmiosUrl });

  try {
    process.stderr.write(`building publish tx...\n`);
    const slotConfig = vectorSlotConfig(networkId, env.VECTOR_ZERO_TIME_MS);
    const [protocol, wallet] = await Promise.all([ogmiosProtocolParameters(ogmiosUrl), chain.queryUtxosByAddress(walletKey.address)]);
    const tx = buildPublishReferenceScripts(
      { networkId, slotConfig, protocol, wallet, changeAddress: walletKey.address },
      {
        scripts: [
          { compiledCode: scripts.escrow.compiledCode, lovelace: escrowLovelace },
          { compiledCode: scripts.advert.compiledCode, lovelace: advertLovelace },
        ],
        window: validityWindow(Date.now(), slotConfig),
      },
    );
    const [escrowRef, advertRef] = tx.references;
    process.stderr.write(`fee: ${tx.fee} lovelace; escrow output ${escrowRef!.lovelace}, advert output ${advertRef!.lovelace} lovelace\n`);
    const txHash = await chain.submitTx(await signTransaction(tx.txCborHex, privHex));
    process.stderr.write(`submitted: ${txHash}\n`);
    process.stdout.write(`${scripts.escrowEnv}=${txHash}#${escrowRef!.ref.index}\n`);
    process.stdout.write(`${scripts.advertEnv}=${txHash}#${advertRef!.ref.index}\n`);
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
  main(process.argv.slice(2), process.env).then((code) => process.exit(code));
}
