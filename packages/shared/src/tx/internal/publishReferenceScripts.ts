/**
 * publishReferenceScripts.ts — the builder that publishes Plutus V3 scripts as
 * CIP-33 reference UTxOs. It is the only publisher in the repository:
 *
 * - supplier/src/cli/publish-reference-scripts.ts publishes the escrow and the
 *   advert in one transaction;
 * - contracts/identity-marketplace/deploy publishes each identity-side script
 *   in its own transaction.
 *
 * Each script gets one output at `to`, with the script as reference script
 * and no datum. The output holds the ledger minimum (min-UTxO) unless the
 * caller gives more. The default address is the enterprise address whose key
 * hash is 28 zero bytes: nobody holds its key, so nobody can spend the
 * reference outputs (Part 2 §2). Script-spending transactions then reference
 * these outputs and do not carry the script bytes.
 *
 * The builder is pure (identity/tx `completeTx`): it returns an unsigned
 * transaction. The caller signs it (`signTransaction`) and submits it.
 */

import type { OutputReference } from "../../chain/ChainProvider.js";
import type { NetworkId } from "../../network.js";
import { completeTx } from "../../identity/tx/complete.js";
import { coinForOutput, enterpriseAddress, paymentCredential, plutusV3Hash, type TxOutput } from "../../identity/tx/ledger.js";
import { refuse, type TxContext, type UnsignedTx, type ValidityWindow } from "../../identity/tx/types.js";

/** The key hash of the reference-script address: 28 zero bytes. */
export const REFERENCE_SCRIPT_KEY_HASH = "00".repeat(28);

/** The default address of reference scripts: the enterprise address of the zero key hash. */
export function referenceScriptAddress(networkId: NetworkId): string {
  return enterpriseAddress({ type: "VerificationKey", hash: REFERENCE_SCRIPT_KEY_HASH }, networkId);
}

export interface ReferenceScript {
  /** CIP-57 `compiledCode` of a Plutus V3 script (one CBOR byte string around the flat program). */
  compiledCode: string;
  /** AP3X base units of the reference output. Default and minimum: the ledger minimum of the output. */
  lovelace?: bigint;
}

export interface PublishReferenceScriptsArgs {
  /** One reference output per script, in this order. */
  scripts: readonly ReferenceScript[];
  /** Where the reference outputs go. Default: `referenceScriptAddress(ctx.networkId)`. */
  to?: string;
  window: ValidityWindow;
}

export interface PublishedReference {
  /** The script hash of the reference script. */
  hash: string;
  /** The reference output: `scripts[i]` is output `i`. */
  ref: OutputReference;
  lovelace: bigint;
  /** The ledger minimum of the output. */
  minLovelace: bigint;
}

export interface PublishReferenceScriptsTx extends UnsignedTx {
  /** The reference output of each script, in the order of `scripts`. */
  references: PublishedReference[];
}

/** One transaction with a reference output for each script. The wallet of `ctx` pays the outputs and the fee. */
export function buildPublishReferenceScripts(ctx: TxContext, args: PublishReferenceScriptsArgs): PublishReferenceScriptsTx {
  if (args.scripts.length === 0) refuse("no_reference_scripts", "give at least one script to publish");
  const to = args.to ?? referenceScriptAddress(ctx.networkId);
  if (paymentCredential(to) === null) refuse("reference_address_invalid", `${to} has no payment credential`);
  const outputs: TxOutput[] = [];
  const minimums: bigint[] = [];
  for (const [i, script] of args.scripts.entries()) {
    if (!/^(?:[0-9a-f]{2})+$/.test(script.compiledCode)) refuse("script_invalid", `script ${i}: compiled code must be lowercase hex`);
    const shape = { address: to, assets: [], datum: null, scriptRef: script.compiledCode };
    const minimum = coinForOutput(shape, ctx.protocol.coinsPerUtxoByte);
    const lovelace = script.lovelace ?? minimum;
    if (lovelace < minimum) {
      refuse("reference_output_too_small", `script ${i}: ${lovelace} base units is below the ledger minimum ${minimum} of its output`);
    }
    outputs.push({ ...shape, coin: lovelace });
    minimums.push(minimum);
  }
  const tx = completeTx(ctx, {
    inputs: [],
    referenceInputs: [],
    outputs,
    mints: [],
    withdrawals: [],
    extraSignatories: [],
    window: args.window,
  });
  return {
    ...tx,
    references: outputs.map((output, index) => ({
      hash: plutusV3Hash(output.scriptRef!),
      ref: { txHash: tx.txHash, index },
      lovelace: output.coin,
      minLovelace: minimums[index]!,
    })),
  };
}
