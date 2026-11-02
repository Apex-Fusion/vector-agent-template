/**
 * tx/internal/liveIdentityCbor.ts — lucid-evolution spends of the identity
 * layout: the new escrow (Part 2 §6.1) and the new advert (§6.2).
 *
 * The builders in tx/escrow and tx/advert run every check and plan the
 * transaction (internal/identitySpend.ts). buildLiveScriptSpend writes exactly
 * that plan:
 * - one script input; the planned outputs first, in plan order (output 0 is
 *   the continuing output of Claim and Submit), then lucid's change;
 * - the planned reference inputs (the agent record) and, when the env key is
 *   set, the reference script, whose hash must be the planned script hash;
 *   else the applied script in the witness set;
 * - the required signers and the slot-aligned window [lo, hi];
 * - no mint, withdrawal, certificate, vote or proposal (§6.1 rules 1 and 2).
 * Wallet inputs are key-locked, so the planned input is the only script
 * input. Phase-2 evaluation goes to Ogmios, as in liveCbor.ts.
 */

import { CML, PROTOCOL_PARAMETERS_DEFAULT, assetsToValue } from "@lucid-evolution/lucid";
import type { Script, UTxO as LucidUTxO } from "@lucid-evolution/lucid";

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { loadIdentityBlueprint, type IdentityBlueprint } from "../blueprint.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { createLucidContext } from "./lucidContext.js";
import {
  assertCollateralCandidate, buildLucidProvider, chainUtxoToLucidScriptInput, reserveScriptSpendCollateral,
  resolveSpendCtx, rethrowAsTxError, withoutInputs, type RefUtxoEnvKey,
} from "./liveCbor.js";
import type { ValidityWindow } from "../../identity/tx/types.js";

/** The new escrow script (identity_hash applied) and its mainnet address, for publishing as a reference script. */
export function loadIdentityEscrowScript(
  blueprint: IdentityBlueprint = loadIdentityBlueprint(),
): { script: Script; address: string; hash: string } {
  return {
    script: { type: "PlutusV3", script: blueprint.escrowCompiledCode },
    address: blueprint.escrowScriptAddress(1),
    hash: blueprint.escrowScriptHash,
  };
}

/** The new advert script and its mainnet address, for publishing as a reference script. */
export function loadIdentityAdvertScript(
  blueprint: IdentityBlueprint = loadIdentityBlueprint(),
): { script: Script; address: string; hash: string } {
  return {
    script: { type: "PlutusV3", script: blueprint.advertCompiledCode },
    address: blueprint.advertScriptAddress(1),
    hash: blueprint.advertScriptHash,
  };
}

/** A planned output with a mainnet address. */
export interface LiveOutput {
  address: string;
  lovelace: bigint;
  assets: Record<string, bigint>;
  /** Inline datum as CBOR hex; null for no datum. */
  datumHex: string | null;
  /** The script compares this output's value with the input: refuse when the ledger minimum would raise it. */
  exactValue: boolean;
}

export interface LiveScriptSpendParams {
  chain: LiveOgmiosProvider;
  /** Signs, and pays the fee and the collateral. */
  walletKey: WalletKey;
  /** The one script output that the transaction spends. */
  input: Utxo;
  script: { compiledCode: string; hash: string; address: string; refEnvKey: RefUtxoEnvKey };
  redeemerHex: string;
  referenceInputs: readonly Utxo[];
  outputs: readonly LiveOutput[];
  requiredSigners: readonly string[];
  window: ValidityWindow;
  /** Keep the dedicated collateral UTxO out of the inputs (buyer-side spends, as Accept and Reclaim). */
  reserveCollateral: boolean;
  excludeInputs?: readonly OutputReference[];
  beforeSubmit?: (built: BuildResult) => Promise<void>;
  /** For error messages, for example "claim". */
  action: string;
}

/**
 * Lucid assets: lovelace and units of policy ID + asset name without a
 * separator (the Ogmios chain providers write "policy.name").
 */
function lucidAssets(lovelace: bigint, assets: Record<string, bigint>): Record<string, bigint> {
  const out: Record<string, bigint> = { lovelace };
  for (const [unit, quantity] of Object.entries(assets)) out[unit.replace(".", "")] = quantity;
  return out;
}

/**
 * The lovelace that lucid gives `output`: it raises an amount below the
 * ledger minimum to that minimum (Pay.ts `with_asset_and_min_required_coin`).
 */
function minimumLovelace(output: LiveOutput, coinsPerUtxoByte: bigint): bigint {
  let builder = CML.TransactionOutputBuilder.new().with_address(CML.Address.from_bech32(output.address));
  if (output.datumHex !== null) {
    builder = builder.with_data(CML.DatumOption.new_datum(CML.PlutusData.from_cbor_hex(output.datumHex)));
  }
  const value = assetsToValue(lucidAssets(output.lovelace, output.assets));
  return builder.next().with_asset_and_min_required_coin(value.multi_asset(), coinsPerUtxoByte).build().output().amount().coin();
}

export async function buildLiveScriptSpend(params: LiveScriptSpendParams): Promise<BuildResult> {
  const provider = buildLucidProvider(params.chain);
  const { lucid } = await createLucidContext(provider, params.walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const coinsPerUtxoByte = lucid.config().protocolParameters?.coinsPerUtxoByte ?? PROTOCOL_PARAMETERS_DEFAULT.coinsPerUtxoByte;
  for (const output of params.outputs) {
    if (!output.exactValue) continue;
    const minimum = minimumLovelace(output, coinsPerUtxoByte);
    if (output.lovelace < minimum) {
      throw new TxConstructionError(
        "escrow below min-UTxO",
        `the continuing output needs ${minimum} lovelace, the escrow holds ${output.lovelace}`,
      );
    }
  }

  const inlineScript: Script = { type: "PlutusV3", script: params.script.compiledCode };
  const spendCtx = await resolveSpendCtx(lucid, params.script.refEnvKey, inlineScript, params.script.hash);
  const walletUtxos = withoutInputs(await lucid.wallet().getUtxos(), params.excludeInputs);
  assertCollateralCandidate(walletUtxos);
  const paidOut = params.outputs.reduce((sum, output) => sum + output.lovelace, 0n);
  const presetWalletInputs = params.reserveCollateral
    ? reserveScriptSpendCollateral(walletUtxos, paidOut - params.input.lovelace) ?? walletUtxos
    : walletUtxos;
  const references: LucidUTxO[] = params.referenceInputs.map((utxo) => ({
    txHash: utxo.ref.txHash,
    outputIndex: utxo.ref.index,
    address: utxo.address,
    assets: lucidAssets(utxo.lovelace, utxo.assets),
    datumHash: null,
    datum: utxo.datumHex,
    scriptRef: null,
  }));
  const input = chainUtxoToLucidScriptInput(params.input, params.script.address);
  input.assets = lucidAssets(params.input.lovelace, params.input.assets);

  let signed;
  try {
    let tx = spendCtx.kind === "ref"
      ? lucid.newTx().readFrom([spendCtx.refUtxo, ...references])
      : lucid.newTx().attach.SpendingValidator(spendCtx.script);
    if (spendCtx.kind === "inline" && references.length > 0) tx = tx.readFrom(references);
    tx = tx.collectFrom([input], params.redeemerHex);
    for (const output of params.outputs) {
      const assets = lucidAssets(output.lovelace, output.assets);
      tx = output.datumHex === null
        ? tx.pay.ToAddress(output.address, assets)
        : tx.pay.ToAddressWithData(output.address, { kind: "inline", value: output.datumHex }, assets);
    }
    for (const signer of params.requiredSigners) tx = tx.addSignerKey(signer);
    tx = tx
      .validFrom(params.window.lo)
      .validTo(params.window.hi)
      // Same fee floor and Ogmios evaluation as the legacy spends (liveCbor.ts).
      .setMinFee(500_000n);
    const completed = await tx.complete({ presetWalletInputs, localUPLCEval: false });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, `${params.action} build failed`);
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await params.beforeSubmit?.({ txCborHex, expectedTxHash });
  await params.chain.submitTx(txCborHex);
  return { txCborHex, expectedTxHash };
}
