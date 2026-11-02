/**
 * tx/escrow/postFromAdvert.ts — the advert-to-escrow part that the four Post
 * builders share (postEscrow, postChatEscrow, postOcrEscrow, postTtsEscrow).
 * Each builder computes its prompt_hash and calls postEscrowFromAdvert.
 *
 * Off-chain invariants (both layouts):
 *   1. advert UTxO exists at advertRef, with an inline datum
 *   2. advert datum.status === "Active"
 *   3. payment_lovelace === advert.price_lovelace
 *   4. buyerKey.pubKeyHash !== advert.supplier_pkh
 *   5. hi − lo ≤ MAX_RANGE_MS: hi = min(deliver_by, lo + 1 h) (Part 2 §6.5)
 *   6. value cap (Part 2 §6.5, F-29): payment, buyer bond and supplier bond
 *      each ≥ 0, their sum ≤ 10,000 AP3X, and the locked amount
 *      ≤ 10,005 AP3X. §6.5 names every Post builder, so a legacy escrow gets
 *      the cap too (as the indexer listing does).
 *
 * The advert decides the layout (Part 2 §9.6): a legacy advert gives a legacy
 * escrow, a new advert (14 fields) a new escrow. `escrowLayout` pins the
 * layout, for example "identity" after the switch. A new escrow also needs
 * (Part 2 §6.1, §6.2, §6.5):
 *   7. the advert at the new advert script;
 *   8. agent_id copied from the advert; refund = the buyer's own address
 *      (buyerKey.address, whose payment key must be the buyer key), no datum;
 *   9. a listed advert: the transaction that created it lists supplier_pkh as
 *      a required signer (lookupAdvertSigners), and the record of agent_id is
 *      authentic, independent and effectively Active at posted_at, with
 *      supplier_pkh as a listed key with the transaction purpose and with
 *      capability_id (lookupRecord).
 */

// Namespace import — see blueprint.ts header.
import * as nodeCrypto from "crypto";
import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { EscrowDatum } from "../../cbor/types.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { encodeIdentityEscrowDatum, type IdentityEscrowDatum } from "../../cbor/IdentityEscrowDatum.js";
import type { IdentityAdvertDatum } from "../../cbor/IdentityAdvertDatum.js";
import { plutusAddressFromBech32, type PlutusAddress } from "../../cbor/address.js";
import { canonicalize } from "../../cbor/canonical.js";
import { loadBlueprint, loadIdentityBlueprint, type IdentityBlueprint } from "../blueprint.js";
import type { AdvertSignersLookup, RecordLookup } from "../identityRecord.js";
import { assertAdvertAgentListed } from "../advert/identityAdvert.js";
import type { PostEscrowBuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { encodeTxBody, sha256Hex } from "../internal/testTxBody.js";
import { MAX_RANGE_MS, mockSlotToWallclockMs, NETWORK_BUFFER_MS } from "../internal/constants.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { escrowLockFloor } from "../internal/minAdaFloor.js";
import { paidToScript, readAdvert, type MarketplaceLayout } from "../internal/layout.js";
import { assertEscrowWithinCap } from "./identityEscrow.js";
import type { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

/** Layout options of the four Post builders. */
export interface PostEscrowLayoutOptions {
  /** Refuse an advert of the other layout. Default: follow the advert. */
  escrowLayout?: MarketplaceLayout;
  /** New advert only: finds the agent record (required). */
  lookupRecord?: RecordLookup;
  /** New advert only: the required signers of the transaction that created the advert (required). */
  lookupAdvertSigners?: AdvertSignersLookup;
  /** New advert only. Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
}

export interface PostFromAdvertArgs extends PostEscrowLayoutOptions {
  chain: ChainProvider;
  buyerKey: WalletKey;
  advertRef: OutputReference;
  /** 32-byte hex commitment, already validated by the caller. */
  promptHash: string;
  payment_lovelace: bigint;
  beforeSubmit?: (built: PostEscrowBuildResult) => Promise<void>;
  excludeInputs?: readonly OutputReference[];
}

/** The buyer's own address for `refund`: its payment credential must be the buyer key. */
function buyerRefundAddress(buyerKey: WalletKey): PlutusAddress {
  let address: PlutusAddress;
  try {
    address = plutusAddressFromBech32(buyerKey.address);
  } catch (err) {
    throw new TxConstructionError("buyer address mismatch", `buyerKey.address: ${(err as Error).message}`);
  }
  const payment = address.paymentCredential;
  if (payment.type !== "VerificationKey" || payment.hash !== buyerKey.pubKeyHash) {
    throw new TxConstructionError(
      "buyer address mismatch",
      `buyerKey.address ${buyerKey.address} does not pay to the buyer key ${buyerKey.pubKeyHash}`,
    );
  }
  return address;
}

/** Check 9: the listing rule of §6.2 for the advert and its agent. */
async function assertAdvertListed(
  args: PostFromAdvertArgs,
  blueprint: IdentityBlueprint,
  advert: IdentityAdvertDatum,
  postedAt: number,
): Promise<void> {
  if (args.lookupAdvertSigners === undefined) {
    throw new TxConstructionError("advert signers lookup required", "a new advert needs lookupAdvertSigners");
  }
  const signers = await args.lookupAdvertSigners(args.advertRef);
  if (signers === null) {
    throw new TxConstructionError("advert signers unknown", "the transaction that created the advert is unknown");
  }
  if (!signers.includes(advert.supplier_pkh)) {
    throw new TxConstructionError(
      "advert not listed",
      `the transaction that created the advert does not list supplier_pkh ${advert.supplier_pkh} as a signer`,
    );
  }
  await assertAdvertAgentListed(args.lookupRecord, blueprint, advert, postedAt);
}

export async function postEscrowFromAdvert(args: PostFromAdvertArgs): Promise<PostEscrowBuildResult> {
  const { chain, buyerKey, advertRef, payment_lovelace } = args;

  // 1. Advert UTxO must exist.
  const advert = await readAdvert(chain, advertRef);
  if (args.escrowLayout !== undefined && args.escrowLayout !== advert.layout) {
    throw new TxConstructionError(
      "advert layout mismatch",
      `expected a ${args.escrowLayout} advert, got a ${advert.layout} advert`,
    );
  }
  const advertDatum = advert.datum;

  // 2. Advert must be Active.
  if (advertDatum.status !== "Active") {
    throw new TxConstructionError(
      "advert is retired",
      `advert.status is ${advertDatum.status}, expected Active`,
    );
  }

  // 3. Payment must equal advertised price.
  if (payment_lovelace !== advertDatum.price_lovelace) {
    throw new TxConstructionError(
      "payment must equal advertised price",
      `payment ${payment_lovelace} != advert.price ${advertDatum.price_lovelace}`,
    );
  }

  // 4. Buyer cannot be supplier.
  if (buyerKey.pubKeyHash === advertDatum.supplier_pkh) {
    throw new TxConstructionError(
      "buyer cannot be supplier",
      `buyerKey pkh ${buyerKey.pubKeyHash} equals advert.supplier_pkh`,
    );
  }

  // Derive escrow datum fields.
  // Time source depends on backend:
  //   - live  → Date.now() (real POSIX ms; lucid emits real validity ranges)
  //   - mock  → mockSlotToWallclockMs(tipSlot) (synthetic slot * 1000 convention)
  const tipSlot = await chain.tip();
  const isLive = detectCborBackend(chain) === "live";
  const postedAt = isLive ? Date.now() : mockSlotToWallclockMs(tipSlot);
  const deliverBy = postedAt + advertDatum.max_processing_ms + NETWORK_BUFFER_MS;

  const requestSpecHash = nodeCrypto.createHash("sha256").update(canonicalize({
    capability_id: advertDatum.capability_id,
    max_output_tokens: advertDatum.max_output_tokens,
    model: advertDatum.model,
  }), "utf8").digest("hex");

  const economicTotal =
    advertDatum.price_lovelace +
    advertDatum.buyer_bond_lovelace +
    advertDatum.supplier_bond_lovelace;

  const legacyDatum: EscrowDatum = {
    buyer_pkh: buyerKey.pubKeyHash,
    supplier_pkh: advertDatum.supplier_pkh,
    advert_ref: advertRef,
    capability_id: advertDatum.capability_id,
    request_spec_hash: requestSpecHash,
    prompt_hash: args.promptHash,
    payment_lovelace: advertDatum.price_lovelace,
    buyer_bond_lovelace: advertDatum.buyer_bond_lovelace,
    supplier_bond_lovelace: advertDatum.supplier_bond_lovelace,
    deliver_by: deliverBy,
    posted_at: postedAt,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
  };

  let identity: { blueprint: IdentityBlueprint; datum: IdentityEscrowDatum } | null = null;
  if (advert.layout === "identity") {
    const blueprint = args.identityBlueprint ?? loadIdentityBlueprint();
    // 7. A 14-field advert counts only at the new advert script.
    if (!paidToScript(advert.utxo.address, blueprint.advertScriptHash)) {
      throw new TxConstructionError("advert not listed", `advert ${advertRef.txHash}#${advertRef.index} is not at the new advert script`);
    }
    // 8. agent_id from the advert; buyer payouts go back to the buyer's own address.
    identity = {
      blueprint,
      datum: {
        ...legacyDatum,
        agent_id: advert.datum.agent_id,
        refund: { address: buyerRefundAddress(buyerKey), datum: null },
      },
    };
  }

  // Lock enough that the escrow output satisfies min-ada in its LARGEST
  // future state (Submitted) - value_equal on Claim/Submit forbids any
  // later bump (min-ada floor).
  const totalLocked = escrowLockFloor(identity?.datum ?? legacyDatum, economicTotal);

  // 6. Value cap (F-29), both layouts.
  assertEscrowWithinCap(identity?.datum ?? legacyDatum, totalLocked);
  if (identity !== null && advert.layout === "identity") {
    // 9. The listing rule.
    await assertAdvertListed(args, identity.blueprint, advert.datum, postedAt);
  }

  // Live path: produce real Cardano CBOR via lucid-evolution.
  if (isLive) {
    const liveCborPath = "../internal/liveCbor.js";
    const { buildLiveTxForEscrow } = await import(/* @vite-ignore */ liveCborPath);
    return buildLiveTxForEscrow({
      chain: chain as LiveOgmiosProvider,
      buyerKey,
      advertRef,
      messages: [],
      escrowDatum: legacyDatum,
      totalLocked,
      deliverBy,
      postedAt,
      beforeSubmit: args.beforeSubmit,
      excludeInputs: args.excludeInputs,
      target: identity === null
        ? undefined
        : { address: identity.blueprint.escrowScriptAddress(1), datumHex: encodeIdentityEscrowDatum(identity.datum) },
    });
  }

  // Mock backend path (synthetic JSON-in-hex tx body).
  const target = identity === null
    ? { blueprint: loadBlueprint(), datumHex: encodeEscrowDatum(legacyDatum) }
    : { blueprint: identity.blueprint, datumHex: encodeIdentityEscrowDatum(identity.datum) };
  const body = {
    type: "post-escrow",
    inputs: [],
    outputs: [
      {
        ref: { txHash: "$self", index: 0 },
        address: target.blueprint.escrowScriptAddress(0),
        lovelace: totalLocked,
        assets: {},
        datumHex: target.datumHex,
        scriptRef: null,
      },
    ],
    requiredSigners: [buyerKey.pubKeyHash],
    validityRange: { lowerBoundMs: postedAt, upperBoundMs: Math.min(deliverBy, postedAt + MAX_RANGE_MS) },
    meta: { script_hash: target.blueprint.escrowScriptHash, advert_ref: advertRef },
  };

  const txCborHex = encodeTxBody(body);
  const expectedTxHash = sha256Hex(txCborHex);
  const built: PostEscrowBuildResult = {
    txCborHex,
    expectedTxHash,
    escrowOutputRef: { txHash: expectedTxHash, index: 0 },
  };

  await args.beforeSubmit?.(built);
  await chain.submitTx(txCborHex);

  return built;
}
