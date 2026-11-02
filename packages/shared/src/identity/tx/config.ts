/**
 * The configuration seal (Part 2 §3.8): `config_seal` mints the token
 * `identity-config` once, in the transaction that spends its seed, to the
 * `config_holder` address with the 28-byte Module-1 hash as inline datum.
 * `config_holder` rejects every spend, so the record never changes.
 */

import type { Utxo } from "../../chain/ChainProvider.js";
import type { PlutusData } from "../../cbor/plutus-data.js";
import { completeTx } from "./complete.js";
import { coinForOutput, enterpriseAddress, paymentCredential } from "./ledger.js";
import { CONFIG_TOKEN_NAME } from "./records.js";
import { refuse, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow } from "./types.js";

export interface ConfigSealArgs {
  /** The seed of `config_seal` (its first parameter). A key-locked UTxO; the transaction spends it. */
  seed: Utxo;
  /** `config_seal` applied with the seed and the holder hash. Its hash is `config_policy`. */
  seal: ScriptSource;
  /** The `config_holder` script hash (the second parameter of `config_seal`). */
  configHolder: string;
  /** M1: the 28-byte hash of Module-1 `identity_party`. Check it against the Module-1 blueprint before the seal (§3.8 step 6). */
  module1: string;
  window: ValidityWindow;
}

/** The mint redeemer of `config_seal`: any Data; the builder uses constructor 0 without fields. */
const SEAL_REDEEMER: PlutusData = { kind: "constr", index: 0n, fields: [] };

export interface ConfigSealTx extends UnsignedTx {
  /** The index of the configuration record in `outputs`. */
  configOutput: number;
}

/** The seal: mint `identity-config` to the holder address with M1 as inline datum. */
export function buildConfigSeal(ctx: TxContext, args: ConfigSealArgs): ConfigSealTx {
  if (!/^[0-9a-f]{56}$/.test(args.module1)) refuse("module1_hash_invalid", "M1 must be a 28-byte script hash (56 lowercase hex characters)");
  if (!/^[0-9a-f]{56}$/.test(args.configHolder)) refuse("config_holder_invalid", "config_holder must be a 28-byte script hash");
  if (paymentCredential(args.seed.address)?.type !== "VerificationKey") refuse("seed_not_key_locked", "the seed must be a key-locked UTxO");
  const shape = {
    address: enterpriseAddress({ type: "Script", hash: args.configHolder }, ctx.networkId),
    assets: [{ policy: args.seal.hash, name: CONFIG_TOKEN_NAME, quantity: 1n }],
    datum: { kind: "bytes", hex: args.module1 } satisfies PlutusData,
    scriptRef: null,
  };
  const tx = completeTx(ctx, {
    inputs: [{ utxo: args.seed }],
    referenceInputs: [],
    outputs: [{ ...shape, coin: coinForOutput(shape, ctx.protocol.coinsPerUtxoByte) }],
    mints: [{
      policy: args.seal.hash,
      assets: [{ name: CONFIG_TOKEN_NAME, quantity: 1n }],
      redeemer: { data: SEAL_REDEEMER, label: "config_seal mint" },
      script: args.seal,
    }],
    withdrawals: [],
    extraSignatories: [],
    window: args.window,
  });
  return { ...tx, configOutput: 0 };
}
