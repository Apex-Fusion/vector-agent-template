/**
 * tx/internal/liveCbor.ts — lucid-evolution CBOR helpers for the 4 in-scope builders.
 *
 * Each function here is called by the corresponding builder when the chain
 * provider is a LiveOgmiosProvider. Pre-chain validation has already run in
 * the caller; we receive validated parameters and produce real Cardano CBOR.
 *
 * Network: Mainnet (per architecture decision documented in lucid-context.test.ts).
 * Output addresses use mainnet header bytes (0x71 for script enterprise, 0x61
 * for vkh enterprise). Input UTxOs may carry testnet-prefixed addresses — lucid
 * does not validate address network for inputs (only for outputs).
 *
 * Deferred builders: only updateAdvert remains on the synthetic testTxBody
 * path. postAdvert, retireAdvert, reclaim, and release all have live builders.
 *
 * Catherine M1-F-4-green.
 */

import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import type { LucidEvolution, UTxO as LucidUTxO, Script } from "@lucid-evolution/lucid";

import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import type { AdvertDatum, EscrowDatum } from "../../cbor/types.js";
import type {
  ChatMessage,
  BuildResult,
  PostAdvertBuildResult,
  PostEscrowBuildResult,
  WalletKey,
} from "../types.js";
import { TxConstructionError } from "../types.js";

import { encodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { plutusTag } from "../../cbor/plutus-tag.js";
import { encodePlutus } from "../../cbor/plutus-encoder.js";
import { loadBlueprint } from "../blueprint.js";
import { pkhToEnterpriseAddress } from "./pkhAddress.js";
import { OgmiosLucidProvider } from "../../chain/OgmiosLucidProvider.js";
import { createLucidContext } from "./lucidContext.js";
import { ACCEPT_WINDOW_MS } from "./constants.js";

// Mainnet network id used for all output addresses produced by the live path.
const MAINNET_ID: 0 | 1 = 1;

// Min UTxO floor for outputs (lovelace). 2 ADA matches the test's expectation.
const MIN_UTXO_LOVELACE = 2_000_000n;

// Redeemer Constr indices per contracts/marketplace/validators/escrow.ak +
// lib/marketplace/types.ak EscrowRedeemer:
//   Claim                          → Constr0 (tag 121, nullary)
//   Submit { receipt_hash }        → Constr1 (tag 122, one ByteArray field)
//   Accept                         → Constr2 (tag 123, nullary)
//   Reclaim                        → Constr3 (tag 124, nullary)
//   Release                        → Constr4 (tag 125, nullary)
const REDEEMER_CLAIM = 121;
const REDEEMER_SUBMIT = 122;
const REDEEMER_ACCEPT = 123;
const REDEEMER_RECLAIM = 124;
const REDEEMER_RELEASE = 125;

// AdvertRedeemer Constr indices per lib/marketplace/types.ak:
//   PostAdvert    → Constr0 (tag 121, creation event — never seen by spend)
//   UpdateAdvert  → Constr1 (tag 122, nullary)
//   RetireAdvert  → Constr2 (tag 123, nullary)
const REDEEMER_RETIRE_ADVERT = 123;

// ─── Param types (legacy stub shape — preserved for compatibility) ────────────

export interface LivePostEscrowParams {
  chain: LiveOgmiosProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  messages: ChatMessage[];
  escrowDatum: EscrowDatum;
  totalLocked: bigint;
  deliverBy: number;
  postedAt: number;
}

export interface LiveClaimParams {
  chain: LiveOgmiosProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  deliverBy: number;
  tipMs: number;
}

export interface LiveSubmitParams {
  chain: LiveOgmiosProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  deliverBy: number;
  tipMs: number;
  receiptHash: string;
}

export interface LiveAcceptParams {
  chain: LiveOgmiosProvider;
  buyerKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  datum: EscrowDatum;
  tipMs: number;
  windowEnd: number;
}

export interface LiveReclaimParams {
  chain: LiveOgmiosProvider;
  buyerKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  datum: EscrowDatum;
  tipMs: number;
}

export interface LiveReleaseParams {
  chain: LiveOgmiosProvider;
  supplierKey: WalletKey;
  escrowRef: OutputReference;
  escrowUtxo: Utxo;
  datum: EscrowDatum;
  tipMs: number;
}

export interface LivePostAdvertParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  advertDatum: AdvertDatum;
  deposit_lovelace: bigint;
}

export interface LiveRetireAdvertParams {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  advertRef: OutputReference;
  advertUtxo: Utxo;
  datum: AdvertDatum;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex (odd length): ${hex.length}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return out;
}

/** Encode a nullary Plutus Constr (no fields) as hex CBOR. */
function encodeNullaryConstrHex(tag: number): string {
  return bytesToHex(encodePlutus(plutusTag(tag, [])));
}

/** Construct an OgmiosLucidProvider that shares the chain's Ogmios endpoint
 * and the chain's injected fetch (so test mocks see lucid's traffic). */
function buildLucidProvider(chain: LiveOgmiosProvider): OgmiosLucidProvider {
  return new OgmiosLucidProvider({
    ogmiosUrl: chain.url,
    fetch: chain.fetchImpl,
  });
}

/** Load the escrow spending validator script bytes from the blueprint.
 *  Exported so the publish-reference-scripts CLI can publish the same bytes
 *  under a CIP-33 scriptRef without duplicating plutus.json reading. */
export function loadEscrowScript(): { script: Script; address: string } {
  const blueprint = loadBlueprint();
  // Read plutus.json directly to grab compiledCode (the blueprint loader only
  // exposes the hash). We piggyback on the same path resolution.
  const compiled = readEscrowCompiledCode();
  const script: Script = { type: "PlutusV3", script: compiled };
  return { script, address: blueprint.escrowScriptAddress(MAINNET_ID) };
}

let cachedCompiledCode: string | undefined;
function readEscrowCompiledCode(): string {
  if (cachedCompiledCode) return cachedCompiledCode;
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(
    here,
    "..", "..", "..", "..", "..",
    "contracts", "marketplace", "plutus.json",
  );
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    validators: Array<{ title: string; compiledCode?: string }>;
  };
  for (const v of parsed.validators) {
    if (typeof v.title === "string" && v.title.startsWith("escrow.") && typeof v.compiledCode === "string") {
      cachedCompiledCode = v.compiledCode;
      return cachedCompiledCode;
    }
  }
  throw new Error("loadEscrowScript: plutus.json missing escrow validator compiledCode");
}

/** Load the advert spending validator script bytes from the blueprint.
 *  Exported for the same reason as loadEscrowScript above. */
export function loadAdvertScript(): { script: Script; address: string } {
  const blueprint = loadBlueprint();
  const compiled = readAdvertCompiledCode();
  const script: Script = { type: "PlutusV3", script: compiled };
  return { script, address: blueprint.advertScriptAddress(MAINNET_ID) };
}

let cachedAdvertCompiledCode: string | undefined;
function readAdvertCompiledCode(): string {
  if (cachedAdvertCompiledCode) return cachedAdvertCompiledCode;
  const here = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(
    here,
    "..", "..", "..", "..", "..",
    "contracts", "marketplace", "plutus.json",
  );
  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as {
    validators: Array<{ title: string; compiledCode?: string }>;
  };
  for (const v of parsed.validators) {
    if (typeof v.title === "string" && v.title.startsWith("advert.") && typeof v.compiledCode === "string") {
      cachedAdvertCompiledCode = v.compiledCode;
      return cachedAdvertCompiledCode;
    }
  }
  throw new Error("loadAdvertScript: plutus.json missing advert validator compiledCode");
}

/** Parse a `<txhash>#<idx>` env var into an OutRef. Returns null if unset. */
function parseRefUtxoEnv(envKey: string): { txHash: string; outputIndex: number } | null {
  const v = process.env[envKey];
  if (!v) return null;
  const [txHash, idxStr] = v.split("#");
  if (!txHash || !idxStr) {
    throw new Error(`${envKey} must be <txhash>#<idx>, got: ${v}`);
  }
  const outputIndex = Number(idxStr);
  if (!Number.isInteger(outputIndex) || outputIndex < 0) {
    throw new Error(`${envKey} index must be a non-negative integer, got: ${idxStr}`);
  }
  return { txHash, outputIndex };
}

/** Resolve script-witness mode for a spending tx.
 *  - If `<envKey>` is set, fetch the referenced UTxO and use CIP-33 reference-script mode.
 *    The caller threads the UTxO into `tx.readFrom([refUtxo])`; lucid-evolution 0.4.30
 *    auto-extracts `refUtxo.scriptRef` and registers it as a witness
 *    (dist/index.js:1903–1913). No `attach.SpendingValidator` call is needed.
 *  - Otherwise, fall back to the inlined script (current behavior). */
async function resolveSpendCtx(
  lucid: LucidEvolution,
  envKey: "ESCROW_REF_UTXO" | "ADVERT_REF_UTXO",
  inlineScript: Script,
): Promise<{ kind: "ref"; refUtxo: LucidUTxO } | { kind: "inline"; script: Script }> {
  const refSpec = parseRefUtxoEnv(envKey);
  if (!refSpec) return { kind: "inline", script: inlineScript };
  const [refUtxo] = await lucid.utxosByOutRef([refSpec]);
  if (!refUtxo) {
    throw new Error(
      `${envKey} ${refSpec.txHash}#${refSpec.outputIndex} not found on chain`,
    );
  }
  if (!refUtxo.scriptRef) {
    throw new Error(
      `${envKey} ${refSpec.txHash}#${refSpec.outputIndex} has no scriptRef attached`,
    );
  }
  return { kind: "ref", refUtxo };
}

/** Build a lucid-shaped UTxO from our chain Utxo, swapping in the live
 * blueprint's mainnet-flavoured script address so output validation passes
 * on Mainnet network even when the test fixture used a testnet header. */
function chainUtxoToLucidScriptInput(
  utxo: Utxo,
  scriptAddress: string,
): LucidUTxO {
  return {
    txHash: utxo.ref.txHash,
    outputIndex: utxo.ref.index,
    address: scriptAddress,
    assets: { lovelace: utxo.lovelace, ...utxo.assets },
    datumHash: null,
    datum: utxo.datumHex ?? null,
    scriptRef: null,
  };
}

/** Lucid 0.4.30's default `setCollateral` is 5_000_000n; its collateral
 * selector needs a pure-AP3X UTxO ≥ this threshold. Mirror that floor
 * here so we can fail fast with an actionable hint instead of waiting
 * for lucid's deep "wallet must hold a pure-ADA UTxO ≥ 5 ADA" error. */
const COLLATERAL_MIN_LOVELACE = 5_000_000n;

/** Pre-check: assert the wallet has a UTxO that can serve as collateral.
 * Called at the top of each script-spend builder so a fragmented wallet
 * surfaces a clear "run tx:consolidate-wallet" message instead of the
 * deeper lucid error caught downstream by rethrowAsTxError. */
export function assertCollateralCandidate(utxos: LucidUTxO[]): void {
  for (const u of utxos) {
    if (u.assets.lovelace < COLLATERAL_MIN_LOVELACE) continue;
    const onlyLovelace = Object.keys(u.assets).every((k) => k === "lovelace");
    if (onlyLovelace) return;
  }
  const maxLovelace = utxos.reduce(
    (m, u) => (u.assets.lovelace > m ? u.assets.lovelace : m),
    0n,
  );
  throw new TxConstructionError(
    "collateral_required",
    `wallet has no UTxO ≥ ${COLLATERAL_MIN_LOVELACE} lovelace for collateral ` +
      `(have ${utxos.length} UTxO(s), max ${maxLovelace} lovelace). ` +
      `run \`pnpm --filter @marketplace/{supplier,buyer} tx:consolidate-wallet\` to re-shape the wallet.`,
  );
}

/** TxConstructionError wrapping arbitrary lucid failures, surfacing
 * collateral mismatches with a stable substring so tests can assert.
 *
 * Set LIVECBOR_DEBUG=1 to see the full inner error + WASM stack — useful
 * for diagnosing lucid 0.4.30 / CML edge cases (e.g. the set_exunits
 * panic that affects test fixtures but not production). */
function rethrowAsTxError(err: unknown, fallback: string): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (process.env.LIVECBOR_DEBUG) {
    // eslint-disable-next-line no-console
    console.error("[liveCbor] inner error:", err);
    if (err instanceof Error && err.stack) {
      // eslint-disable-next-line no-console
      console.error("[liveCbor] stack:", err.stack);
    }
    if (err instanceof Error && "cause" in err) {
      // eslint-disable-next-line no-console
      console.error("[liveCbor] cause:", (err as Error & { cause?: unknown }).cause);
    }
  }
  const lower = msg.toLowerCase();
  if (
    lower.includes("collateral") ||
    lower.includes("not enough ada") ||
    lower.includes("not enough funds") ||
    lower.includes("insufficient") ||
    lower.includes("empty_utxo") ||
    lower.includes("missing_wallet") ||
    lower.includes("required assets")
  ) {
    throw new TxConstructionError(
      "collateral required: wallet must hold a pure-ADA UTxO ≥ 5 ADA",
      msg,
    );
  }
  throw new TxConstructionError(fallback, msg);
}

/** Choose PostEscrow inputs that PRESERVE a pure-ADA collateral UTxO for the
 * later Accept/Reclaim script-spend. PostEscrow is NOT a script spend, so lucid
 * is otherwise free to consume the dedicated ≥5-ADA collateral UTxO as an
 * ordinary input — leaving the wallet with no collateral candidate and
 * stranding the escrow when Accept later runs (the fragmentation bug observed
 * on back-to-back requests).
 *
 * Reserve the SMALLEST pure-ADA UTxO ≥ collateral floor and fund the escrow
 * from the remaining UTxOs. Returns null (→ default lucid coin selection) when
 * reservation isn't possible or needed:
 *   - a single UTxO (nothing to reserve),
 *   - no qualifying pure-ADA collateral UTxO, or
 *   - excluding it would underfund the escrow. The large-single-UTxO case is
 *     safe under default selection anyway: the change output is itself a
 *     pure-ADA UTxO well above the collateral floor. */
export function reserveCollateralInputs(
  utxos: LucidUTxO[],
  lockedLovelace: bigint,
): LucidUTxO[] | null {
  if (utxos.length < 2) return null;
  const candidates = utxos
    .filter(
      (u) =>
        u.assets.lovelace >= COLLATERAL_MIN_LOVELACE &&
        Object.keys(u.assets).every((k) => k === "lovelace"),
    )
    .sort((a, b) => (a.assets.lovelace < b.assets.lovelace ? -1 : 1));
  if (candidates.length === 0) return null;
  const reserved = candidates[0];
  const remaining = utxos.filter(
    (u) => !(u.txHash === reserved.txHash && u.outputIndex === reserved.outputIndex),
  );
  if (remaining.length === 0) return null;
  const remainingLovelace = remaining.reduce((s, u) => s + u.assets.lovelace, 0n);
  // Cover the locked output + tx fee + a min-change cushion; else fall back.
  if (remainingLovelace < lockedLovelace + 2_000_000n) return null;
  return remaining;
}

// ─── PostEscrow ──────────────────────────────────────────────────────

export async function buildLiveTxForEscrow(
  params: LivePostEscrowParams,
): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, escrowDatum, totalLocked, deliverBy, postedAt } = params;
  void params.advertRef;
  void params.messages;

  const provider = buildLucidProvider(chain);
  // networkParams is not consumed by lucid (lucid uses its own SLOT_CONFIG_NETWORK
  // for "Mainnet"). We pass a placeholder so the LucidContext type stays uniform.
  const { lucid } = await createLucidContext(provider, buyerKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const blueprint = loadBlueprint();
  const escrowAddress = blueprint.escrowScriptAddress(MAINNET_ID);
  const datumHex = encodeEscrowDatum(escrowDatum);

  const lockedLovelace = totalLocked < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : totalLocked;

  // Preserve a pure-ADA collateral UTxO so the buyer's later Accept/Reclaim
  // script-spend can find collateral. Without this, PostEscrow coin selection
  // can consume the 5-ADA collateral UTxO and strand the escrow at Accept.
  const walletUtxos = await lucid.wallet().getUtxos();
  const reservedInputs = reserveCollateralInputs(walletUtxos, lockedLovelace);

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .pay.ToAddressWithData(
        escrowAddress,
        { kind: "inline", value: datumHex },
        { lovelace: lockedLovelace },
      )
      .addSignerKey(buyerKey.pubKeyHash)
      // -60s past buffer: lucid's slotFromUnixTime rounds UP, so passing
      // `Date.now()` produces a slot 1 ahead of the chain's current slot,
      // and Ogmios rejects the tx with code 3118 ("submitted too early")
      // until the chain catches up. Same fix as Claim/Submit/Accept paths
      // below — keep the buffer wide enough to absorb build+propagation.
      .validFrom(postedAt - 60_000)
      .validTo(deliverBy)
      // lucid 0.4.30 under-estimates Conway fees by ~1K lovelace on
      // PostEscrow (Ogmios 3122). 500K is a comfortable floor; excess
      // becomes change. Same fix as Claim/Submit/Accept paths.
      .setMinFee(500_000n);

    // When we can reserve collateral, restrict coin selection to the remaining
    // (working) UTxOs so the collateral candidate survives for Accept. Else
    // fall back to lucid's default selection (single/large-UTxO cases are safe).
    const completed = reservedInputs
      ? await txBuilder.complete({ presetWalletInputs: reservedInputs, localUPLCEval: false })
      : await txBuilder.complete();
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "post-escrow build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);
  // Note: awaiting on-chain confirmation is the SDK's responsibility
  // (Marketplace.submitPrompt awaits before calling the supplier). Keeping
  // the live builder submit-only matches the Claim/Submit/Accept pattern
  // and lets unit tests exercise the builder without stubbing awaitTx.

  return {
    txCborHex,
    expectedTxHash,
    escrowOutputRef: { txHash: expectedTxHash, index: 0 },
  };
}

// ─── Claim / Submit / Accept share input-collection scaffolding ─────────

async function buildSpendOpenOrClaimedTx(opts: {
  chain: LiveOgmiosProvider;
  walletKey: WalletKey;
  escrowUtxo: Utxo;
  newDatum: EscrowDatum;
  /** Pre-encoded redeemer hex. Nullary redeemers use encodeNullaryConstrHex,
   * Submit must include the receipt_hash payload. */
  redeemerHex: string;
  validFromMs: number;
  validToMs: number;
  signerPkh: string;
}): Promise<BuildResult> {
  const provider = buildLucidProvider(opts.chain);
  const { lucid } = await createLucidContext(provider, opts.walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const spendCtx = await resolveSpendCtx(lucid, "ESCROW_REF_UTXO", script);
  const datumHex = encodeEscrowDatum(opts.newDatum);
  const redeemerHex = opts.redeemerHex;
  const lucidInput = chainUtxoToLucidScriptInput(opts.escrowUtxo, escrowAddress);
  const lockedLovelace = opts.escrowUtxo.lovelace < MIN_UTXO_LOVELACE
    ? MIN_UTXO_LOVELACE
    : opts.escrowUtxo.lovelace;

  // Augment wallet inputs with a synthetic large UTxO so coin selection has
  // ample room for collateral + change + script fees. The M1-F-4 happy-path
  // fixtures supply a single 5 ADA wallet UTxO — enough to be detected as
  // having "collateral capability" but not enough on its own to satisfy
  // input + collateral + change min after fees on a script-spend tx. We pad
  // by injecting a 100 ADA synthetic UTxO at the lucid wallet address ONLY
  // when the real wallet has at least one UTxO with ≥5 ADA. That preserves
  // the "no funds" rejection path used by the collateral-required tests
  // (which mock the wallet with <5 ADA or empty UTxOs) while letting the
  // happy path complete coin selection deterministically. The synthetic
  // input is never actually broadcast — chain.submitTx receives the final
  // signed CBOR straight from lucid.toCBOR() and the test mock returns a
  // fixed tx-id without inspecting inputs.
  // Use the wallet's real UTxOs only. The earlier synthetic-padding-input
  // (txHash="0".repeat(64)) was a test-side workaround for a fixture wallet
  // that held only 5 AP3X total; in production the real wallet has many UTxOs
  // and the ledger rejects unknown references. ARCHITECTURE.md §9 #14 cleanup.
  const realWalletUtxos = await lucid.wallet().getUtxos();
  assertCollateralCandidate(realWalletUtxos);

  let signed;
  try {
    const txBuilder = (
      spendCtx.kind === "ref"
        ? lucid.newTx().readFrom([spendCtx.refUtxo])
        : lucid.newTx().attach.SpendingValidator(spendCtx.script)
    )
      .collectFrom([lucidInput], redeemerHex)
      .pay.ToAddressWithData(
        escrowAddress,
        { kind: "inline", value: datumHex },
        { lovelace: lockedLovelace },
      )
      .addSignerKey(opts.signerPkh)
      // Set validFrom 60s in the past to absorb the build-vs-submit race —
      // lucid's ms→slot rounds UP to (currentSlot + 1), but Ogmios's ledger
      // sees currentSlot when validating, so a 1-slot gap rejects the tx.
      .validFrom(opts.validFromMs - 60_000)
      .validTo(opts.validToMs)
      // lucid-evolution 0.4.30 under-estimates fee for Plutus V3 spends by
      // ~5K lovelace (Conway minFeeReferenceScripts multiplier appears to be
      // missed). 0.2 AP3X floor leaves headroom for that under-estimate
      // without masking the savings from CIP-33 ref-scripts (natural
      // ref-script tx fee is ~0.24 AP3X; inlined is ~0.34 AP3X — both above
      // the floor, so lucid's estimate wins and the size delta surfaces).
      .setMinFee(500_000n);

    // Let lucid pick coins + compute fee normally; production wallets have
    // multiple real UTxOs (no need for the test-side leftover-as-fee hack).
    //
    // localUPLCEval: false — delegate Plutus V3 phase-2 evaluation to Ogmios
    // (which uses cardano-node's evaluator). lucid 0.4.30's CML WASM UPLC
    // interpreter has a false-rejection bug for our V3 spend pattern: it
    // rejects valid txs with "failed script execution Spend[0] the validator
    // crashed / exited prematurely" while the chain itself accepts them
    // without complaint. Routing eval to Ogmios sidesteps the WASM bug AND
    // produces correct ex-units. The provider already implements evaluateTx
    // (OgmiosLucidProvider.evaluateTx → JSON-RPC evaluateTransaction).
    const completed = await txBuilder.complete({
      presetWalletInputs: realWalletUtxos,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "spend-tx build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await opts.chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}

// ─── Claim ───────────────────────────────────────────────────────────

export async function buildLiveTxForClaim(params: LiveClaimParams): Promise<BuildResult> {
  return buildSpendOpenOrClaimedTx({
    chain: params.chain,
    walletKey: params.supplierKey,
    escrowUtxo: params.escrowUtxo,
    newDatum: params.newDatum,
    redeemerHex: encodeNullaryConstrHex(REDEEMER_CLAIM),
    validFromMs: params.tipMs,
    validToMs: params.deliverBy,
    signerPkh: params.supplierKey.pubKeyHash,
  });
}

// ─── Submit ──────────────────────────────────────────────────────────

export async function buildLiveTxForSubmit(params: LiveSubmitParams): Promise<BuildResult> {
  // Submit { receipt_hash: ByteArray } — Constr1 with a single bytes field.
  const receiptBytes = hexToBytes(params.receiptHash);
  const submitRedeemerHex = bytesToHex(
    encodePlutus(plutusTag(REDEEMER_SUBMIT, [receiptBytes])),
  );
  // The validator's stamp_ok requires
  //   new_datum.submitted_at == Some(upper_bound_of(validity_range))
  // Cardano translates validity_interval_end (a slot) to POSIX ms via
  //   posix_ms = slot * slotLengthMs + zeroTime
  // so upper_bound is ALWAYS slot-aligned. We slot-align stampMs down and
  // pin the datum's submitted_at to that same value.
  //
  // Earlier revision set validFromMs = validToMs = tipMs (slot-aligned). That
  // produced a single-slot validity window at the *current* tip, leaving zero
  // time for the tx to propagate and be included in a block — Ogmios accepted
  // the submit (Phase-1 OK) but the tx was silently evicted from the mempool
  // because no slot in [tip, tip] could hold it. Push stamp forward to give
  // the chain SUBMIT_WINDOW_MS of headroom for inclusion, capped at
  // deliver_by so deadline_ok stays satisfied.
  const VECTOR_ZERO_TIME = Number(process.env.VECTOR_ZERO_TIME_MS) || 1_752_057_484_000;  // ms (env override for mainnet; default = testnet genesis)
  const SLOT_LENGTH = 1_000;                   // ms
  const SUBMIT_WINDOW_MS = 120_000;            // 2-minute inclusion window
  const tipMs = params.tipMs;
  const targetUpperMs = Math.min(tipMs + SUBMIT_WINDOW_MS, params.deliverBy);
  const stampSlot = Math.floor((targetUpperMs - VECTOR_ZERO_TIME) / SLOT_LENGTH);
  const stampMs = stampSlot * SLOT_LENGTH + VECTOR_ZERO_TIME;
  if (stampMs <= tipMs) {
    throw new Error(
      `submit_window_too_tight: tipMs=${tipMs} stampMs=${stampMs} deliverBy=${params.deliverBy}`,
    );
  }
  const alignedDatum = { ...params.newDatum, submitted_at: stampMs };
  return buildSpendOpenOrClaimedTx({
    chain: params.chain,
    walletKey: params.supplierKey,
    escrowUtxo: params.escrowUtxo,
    newDatum: alignedDatum,
    redeemerHex: submitRedeemerHex,
    validFromMs: tipMs,
    validToMs: stampMs,
    signerPkh: params.supplierKey.pubKeyHash,
  });
}

// ─── Accept ──────────────────────────────────────────────────────────

export async function buildLiveTxForAccept(params: LiveAcceptParams): Promise<BuildResult> {
  const provider = buildLucidProvider(params.chain);
  const { lucid } = await createLucidContext(provider, params.buyerKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const spendCtx = await resolveSpendCtx(lucid, "ESCROW_REF_UTXO", script);
  const lucidInput = chainUtxoToLucidScriptInput(params.escrowUtxo, escrowAddress);
  const acceptRedeemerHex = encodeNullaryConstrHex(REDEEMER_ACCEPT);

  // Accept distributes: supplier receives payment+supplier_bond; buyer receives buyer_bond.
  const supplierDue = params.datum.payment_lovelace + params.datum.supplier_bond_lovelace;
  const buyerDue = params.datum.buyer_bond_lovelace;

  // Output addresses must match the lucid network (Mainnet → networkId 1).
  const supplierAddress = pkhToEnterpriseAddress(params.datum.supplier_pkh, MAINNET_ID);
  const buyerAddress = pkhToEnterpriseAddress(params.datum.buyer_pkh, MAINNET_ID);

  // Pad each output to MIN_UTXO_LOVELACE if the bond/payment is below floor —
  // protocol min-utxo, not a semantic change (the chain enforces floors).
  const supplierLovelace = supplierDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : supplierDue;
  const buyerLovelace = buyerDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : buyerDue;

  // Real wallet UTxOs only; the test-side synthetic padding input is removed
  // (it caused unknownOutputReferences errors against the real ledger).
  const realWalletUtxos = await lucid.wallet().getUtxos();
  assertCollateralCandidate(realWalletUtxos);
  const presetWalletInputs = realWalletUtxos;

  let signed;
  try {
    const txBuilder = (
      spendCtx.kind === "ref"
        ? lucid.newTx().readFrom([spendCtx.refUtxo])
        : lucid.newTx().attach.SpendingValidator(spendCtx.script)
    )
      .collectFrom([lucidInput], acceptRedeemerHex)
      .pay.ToAddress(supplierAddress, { lovelace: supplierLovelace })
      .pay.ToAddress(buyerAddress, { lovelace: buyerLovelace })
      .addSignerKey(params.buyerKey.pubKeyHash)
      .validFrom(params.tipMs - 60_000)
      .validTo(params.windowEnd)
      .setMinFee(500_000n);

    // Same UPLC-eval delegation as Claim/Submit (see buildSpendOpenOrClaimedTx
    // for the rationale). lucid 0.4.30's CML WASM evaluator falsely rejects
    // valid Plutus V3 spends; routing to Ogmios's evaluateTransaction
    // (cardano-node's evaluator) sidesteps the bug.
    const completed = await txBuilder.complete({
      presetWalletInputs,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "accept build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await params.chain.submitTx(txCborHex);

  // Re-export the constant so callers that import from liveCbor still see
  // the canonical accept-window value.
  void ACCEPT_WINDOW_MS;

  return { txCborHex, expectedTxHash };
}

// ─── Reclaim ─────────────────────────────────────────────────────────

export async function buildLiveTxForReclaim(params: LiveReclaimParams): Promise<BuildResult> {
  const provider = buildLucidProvider(params.chain);
  const { lucid } = await createLucidContext(provider, params.buyerKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const spendCtx = await resolveSpendCtx(lucid, "ESCROW_REF_UTXO", script);
  const lucidInput = chainUtxoToLucidScriptInput(params.escrowUtxo, escrowAddress);
  const reclaimRedeemerHex = encodeNullaryConstrHex(REDEEMER_RECLAIM);

  // Reclaim returns everything to the buyer: payment + buyer_bond + supplier_bond.
  const buyerDue =
    params.datum.payment_lovelace +
    params.datum.buyer_bond_lovelace +
    params.datum.supplier_bond_lovelace;
  const buyerLovelace = buyerDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : buyerDue;
  const buyerAddress = pkhToEnterpriseAddress(params.datum.buyer_pkh, MAINNET_ID);

  const realWalletUtxos = await lucid.wallet().getUtxos();
  assertCollateralCandidate(realWalletUtxos);
  const presetWalletInputs = realWalletUtxos;

  let signed;
  try {
    const txBuilder = (
      spendCtx.kind === "ref"
        ? lucid.newTx().readFrom([spendCtx.refUtxo])
        : lucid.newTx().attach.SpendingValidator(spendCtx.script)
    )
      .collectFrom([lucidInput], reclaimRedeemerHex)
      .pay.ToAddress(buyerAddress, { lovelace: buyerLovelace })
      .addSignerKey(params.buyerKey.pubKeyHash)
      // Validity range mirrors Accept's pattern: a narrow window centred on
      // tipMs. The on-chain validator only checks `lower_bound >= deliver_by`,
      // which holds as long as `tipMs - 60s >= deliver_by` — the caller has
      // already verified tipMs >= deliver_by, so a 60s back-pad is safe.
      .validFrom(params.tipMs - 60_000)
      .validTo(params.tipMs + 60_000)
      .setMinFee(500_000n);

    // Same UPLC eval delegation as Accept — lucid's CML evaluator falsely
    // rejects valid Plutus V3 spends; route to Ogmios.
    const completed = await txBuilder.complete({
      presetWalletInputs,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "reclaim build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await params.chain.submitTx(txCborHex);
  return { txCborHex, expectedTxHash };
}

// ─── Release ─────────────────────────────────────────────────────────

export async function buildLiveTxForRelease(params: LiveReleaseParams): Promise<BuildResult> {
  const provider = buildLucidProvider(params.chain);
  const { lucid } = await createLucidContext(provider, params.supplierKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: escrowAddress } = loadEscrowScript();
  const spendCtx = await resolveSpendCtx(lucid, "ESCROW_REF_UTXO", script);
  const lucidInput = chainUtxoToLucidScriptInput(params.escrowUtxo, escrowAddress);
  const releaseRedeemerHex = encodeNullaryConstrHex(REDEEMER_RELEASE);

  if (params.datum.submitted_at === null) {
    throw new TxConstructionError(
      "submitted_at missing",
      "Submitted-state escrow must carry a submitted_at timestamp",
    );
  }

  // Release pays everything to the supplier: payment + supplier_bond + buyer_bond.
  const supplierDue =
    params.datum.payment_lovelace +
    params.datum.supplier_bond_lovelace +
    params.datum.buyer_bond_lovelace;
  const supplierLovelace = supplierDue < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : supplierDue;
  const supplierAddress = pkhToEnterpriseAddress(params.datum.supplier_pkh, MAINNET_ID);

  const realWalletUtxos = await lucid.wallet().getUtxos();
  assertCollateralCandidate(realWalletUtxos);
  const presetWalletInputs = realWalletUtxos;

  // escrow.ak:handle_release checks `lower_bound >= submitted_at + ACCEPT_WINDOW`.
  // Clamp validFrom to that threshold: the Reclaim-style tip-60s back-pad alone
  // would violate the validator whenever the tip is less than 60s past the window.
  const threshold = params.datum.submitted_at + ACCEPT_WINDOW_MS;
  const validFromMs = Math.max(threshold, params.tipMs - 60_000);

  let signed;
  try {
    const txBuilder = (
      spendCtx.kind === "ref"
        ? lucid.newTx().readFrom([spendCtx.refUtxo])
        : lucid.newTx().attach.SpendingValidator(spendCtx.script)
    )
      .collectFrom([lucidInput], releaseRedeemerHex)
      .pay.ToAddress(supplierAddress, { lovelace: supplierLovelace })
      .addSignerKey(params.supplierKey.pubKeyHash)
      .validFrom(validFromMs)
      .validTo(params.tipMs + 60_000)
      .setMinFee(500_000n);

    // Same UPLC eval delegation as Accept/Reclaim — lucid's CML evaluator
    // falsely rejects valid Plutus V3 spends; route to Ogmios.
    const completed = await txBuilder.complete({
      presetWalletInputs,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "release build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await params.chain.submitTx(txCborHex);
  return { txCborHex, expectedTxHash };
}

// ─── PostAdvert ──────────────────────────────────────────────────────

export async function buildLiveTxForAdvert(
  params: LivePostAdvertParams,
): Promise<PostAdvertBuildResult> {
  const { chain, walletKey, advertDatum, deposit_lovelace } = params;

  const provider = buildLucidProvider(chain);
  const { lucid } = await createLucidContext(provider, walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const blueprint = loadBlueprint();
  const advertAddress = blueprint.advertScriptAddress(MAINNET_ID);
  const datumHex = encodeAdvertDatum(advertDatum);

  // Pad to protocol min-utxo if the supplier bond is below floor — same
  // pattern as PostEscrow. The validator only checks ≥ supplier_bond_lovelace,
  // so excess ada in the output is fine.
  const lockedLovelace =
    deposit_lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : deposit_lovelace;

  // postAdvert.ts validates advertised_at is within ±5 min of chain tip;
  // a centred 5-min window absorbs the build+submit gap. lucid's slot
  // rounding-up means we still subtract 60s from validFrom like PostEscrow.
  const advertisedAt = advertDatum.advertised_at;

  let signed;
  try {
    const txBuilder = lucid
      .newTx()
      .pay.ToAddressWithData(
        advertAddress,
        { kind: "inline", value: datumHex },
        { lovelace: lockedLovelace },
      )
      .addSignerKey(walletKey.pubKeyHash)
      .validFrom(advertisedAt - 60_000)
      .validTo(advertisedAt + 5 * 60_000)
      .setMinFee(500_000n);

    const completed = await txBuilder.complete();
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "post-advert build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();

  await chain.submitTx(txCborHex);

  return {
    txCborHex,
    expectedTxHash,
    advertOutputRef: { txHash: expectedTxHash, index: 0 },
  };
}

// ─── RetireAdvert ────────────────────────────────────────────────────

export async function buildLiveTxForRetireAdvert(
  params: LiveRetireAdvertParams,
): Promise<BuildResult> {
  const { chain, walletKey, advertUtxo, datum } = params;

  const provider = buildLucidProvider(chain);
  const { lucid } = await createLucidContext(provider, walletKey, {
    networkId: 1,
    systemStartUnix: 0,
    slotLengthMs: 1000,
  }, { usePresetProtocolParameters: true });

  const { script, address: advertAddress } = loadAdvertScript();
  const spendCtx = await resolveSpendCtx(lucid, "ADVERT_REF_UTXO", script);
  const lucidInput = chainUtxoToLucidScriptInput(advertUtxo, advertAddress);
  const retireRedeemerHex = encodeNullaryConstrHex(REDEEMER_RETIRE_ADVERT);

  // Validator only requires: (1) signed by datum.supplier_pkh and (2) at
  // least one output to that pkh's vkh address. Pay the input lovelace
  // (less fee, handled by lucid coin-selection) back to the supplier.
  const supplierAddress = pkhToEnterpriseAddress(datum.supplier_pkh, MAINNET_ID);
  const refundLovelace =
    advertUtxo.lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : advertUtxo.lovelace;

  const presetWalletInputs = await lucid.wallet().getUtxos();
  assertCollateralCandidate(presetWalletInputs);

  let signed;
  try {
    const nowMs = Date.now();
    const txBuilder = (
      spendCtx.kind === "ref"
        ? lucid.newTx().readFrom([spendCtx.refUtxo])
        : lucid.newTx().attach.SpendingValidator(spendCtx.script)
    )
      .collectFrom([lucidInput], retireRedeemerHex)
      .pay.ToAddress(supplierAddress, { lovelace: refundLovelace })
      .addSignerKey(walletKey.pubKeyHash)
      // Validator has no time check, but a sane window absorbs build+submit
      // propagation lag the same as sibling builders.
      .validFrom(nowMs - 60_000)
      .validTo(nowMs + 5 * 60_000)
      .setMinFee(500_000n);

    // Same UPLC-eval delegation as Claim/Submit/Accept — see
    // buildSpendOpenOrClaimedTx for the lucid 0.4.30 false-rejection rationale.
    const completed = await txBuilder.complete({
      presetWalletInputs,
      localUPLCEval: false,
    });
    signed = await completed.sign.withWallet().complete();
  } catch (err) {
    rethrowAsTxError(err, "retire-advert build failed");
  }

  const txCborHex = signed.toCBOR();
  const expectedTxHash = signed.toHash();
  await chain.submitTx(txCborHex);

  return { txCborHex, expectedTxHash };
}
