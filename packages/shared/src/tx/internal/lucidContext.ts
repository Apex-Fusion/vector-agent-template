/**
 * tx/internal/lucidContext.ts — factory for a configured LucidEvolution instance.
 *
 * createLucidContext() wires an OgmiosLucidProvider into lucid-evolution and
 * selects the wallet from a raw Ed25519 private-key hex string.
 *
 * Network choice: lucid receives "Mainnet" per the architecture decision that
 * Vector testnet shares mainnet's CIP-19 networkId byte semantics in the
 * project's address layout. (See lucid-context.test.ts "network ID mapping".)
 *
 * The private-key hex is converted to lucid's required bech32 form
 * (`ed25519_sk1...`) via CML's `PrivateKey.from_normal_bytes(...).to_bech32()`.
 *
 * Catherine M1-F-4-green.
 */

import type { LucidEvolution } from "@lucid-evolution/lucid";
import { Lucid, CML, PROTOCOL_PARAMETERS_DEFAULT, SLOT_CONFIG_NETWORK } from "@lucid-evolution/lucid";
import type { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import type { NetworkParams } from "../../network.js";
import type { WalletKey } from "../types.js";

export interface LucidContext {
  lucid: LucidEvolution;
  networkParams: NetworkParams;
}

const HEX64_RE = /^[0-9a-fA-F]{64}$/;

// ─── Vector testnet genesis slot-config ───────────────────────────────────────
//
// The default `SLOT_CONFIG_NETWORK.Mainnet` lucid ships with corresponds to
// real Cardano mainnet's Shelley genesis (zeroTime = 1596059091000). On
// Vector testnet — which we map to lucid's "Mainnet" tag because it shares the
// CIP-19 networkId byte semantics — the actual genesis is much later
// (1752057484 unix-s) and slots run at 1 s. If we leave the lucid default in
// place, every validity-range that lucid computes from a wallclock-ms uses the
// wrong zero-point and the chain validator rejects the transaction.
//
// applyVectorSlotConfig() mutates the entry to Vector's parameters. It is
// idempotent — repeated calls leave the values identical. createLucidContext
// invokes it before constructing the Lucid instance.

const VECTOR_ZERO_SLOT = 0;
const VECTOR_SLOT_LENGTH = 1000;

export function applyVectorSlotConfig(): void {
  // Read VECTOR_ZERO_TIME_MS lazily so callers that populate process.env after
  // module load (e.g. CLIs that read a .env file at runtime) still get the
  // right value. Capturing this as a module-level const broke run-cycle.ts
  // with the testnet default while pointing at mainnet.
  const VECTOR_ZERO_TIME = Number(process.env.VECTOR_ZERO_TIME_MS) || 1_752_057_484_000;
  const cfg = SLOT_CONFIG_NETWORK["Mainnet"];
  if (
    cfg.zeroTime !== VECTOR_ZERO_TIME ||
    cfg.zeroSlot !== VECTOR_ZERO_SLOT ||
    cfg.slotLength !== VECTOR_SLOT_LENGTH
  ) {
    cfg.zeroTime = VECTOR_ZERO_TIME;
    cfg.zeroSlot = VECTOR_ZERO_SLOT;
    cfg.slotLength = VECTOR_SLOT_LENGTH;
  }
}

// Apply the Vector slot config at module load so any consumer that reads
// SLOT_CONFIG_NETWORK before calling createLucidContext sees the right values.
applyVectorSlotConfig();

export interface CreateLucidContextOpts {
  /** When true (the default), bypass the provider's protocol-params call and
   * use lucid's bundled PROTOCOL_PARAMETERS_DEFAULT (which carries concrete
   * Plutus V1/V2/V3 cost models). The Ogmios mocks in M1-F-4 return empty
   * cost dicts that crash CML's UPLC engine, so the in-memory defaults are
   * the safe choice for tx-construction tests. */
  usePresetProtocolParameters?: boolean;
}

export async function createLucidContext(
  provider: OgmiosLucidProvider,
  walletKey: WalletKey,
  networkParams: NetworkParams,
  opts?: CreateLucidContextOpts,
): Promise<LucidContext> {
  if (!HEX64_RE.test(walletKey.privateKeyHex)) {
    throw new Error(
      `invalid privateKeyHex: expected 64 hex chars (32 bytes), got length=${walletKey.privateKeyHex?.length ?? 0}`,
    );
  }

  // Re-apply the Vector slot config defensively — module-load already ran it,
  // but a test that mutates SLOT_CONFIG_NETWORK between cases would otherwise
  // leak state across tests.
  applyVectorSlotConfig();

  const bech32Priv = hexPrivateKeyToBech32(walletKey.privateKeyHex);

  const useDefaults = opts?.usePresetProtocolParameters ?? false;
  const lucid = useDefaults
    ? await Lucid(provider, "Mainnet", { presetProtocolParameters: PROTOCOL_PARAMETERS_DEFAULT })
    : await Lucid(provider, "Mainnet");
  lucid.selectWallet.fromPrivateKey(bech32Priv);

  return { lucid, networkParams };
}

/** Convert a 32-byte raw Ed25519 hex private key to lucid's bech32 form. */
function hexPrivateKeyToBech32(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  const priv = CML.PrivateKey.from_normal_bytes(bytes);
  return priv.to_bech32();
}
