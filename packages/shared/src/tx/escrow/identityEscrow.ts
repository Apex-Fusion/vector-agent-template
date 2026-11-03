/**
 * tx/escrow/identityEscrow.ts — the identity-layout branches of the escrow
 * builders: Claim, Submit, Accept, Reclaim, Release and RefundRevoked of the
 * new escrow (Part 2 §6.1, §6.5).
 *
 * claim.ts, submit.ts, accept.ts, reclaim.ts and release.ts call these for an
 * escrow with the 16-field datum; refundRevoked.ts calls refundRevokedIdentity.
 * Each function refuses (TxConstructionError) when a rule of §6.1 would make
 * the script fail, then plans exactly one escrow spend with a validity range
 * of at most one hour. Claim, Submit and RefundRevoked read the agent record
 * through the caller's lookup and put it in the reference inputs.
 */

import type { ChainProvider, OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { IdentityDatum, Status } from "../../cbor/IdentityDatum.js";
import {
  encodeEscrowRedeemer, encodeIdentityEscrowDatum, type EscrowRedeemer, type IdentityEscrowDatum, type Refund,
} from "../../cbor/IdentityEscrowDatum.js";
import { encodePlutusDataHex } from "../../cbor/plutus-data.js";
import { plutusAddressToBech32 } from "../../cbor/address.js";
import { MAX_ESCROW_LOVELACE } from "../../identity/constants.js";
import type { SlotConfig } from "../../identity/tx/types.js";
import { loadIdentityBlueprint, type IdentityBlueprint } from "../blueprint.js";
import { assertAgentCanWork, readAgentRecord, type RecordLookup } from "../identityRecord.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import {
  ACCEPT_WINDOW_MS, ESCROW_INPUT_CAP_LOVELACE, MIN_UTXO_LOVELACE, mockSlotToWallclockMs,
} from "../internal/constants.js";
import { submitSpend, type NetworkAddress, type PlannedOutput, type SpendPlan } from "../internal/identitySpend.js";
import { paidToScript } from "../internal/layout.js";
import { pkhToEnterpriseAddress } from "../internal/pkhAddress.js";
import {
  acceptWindow, claimWindow, MOCK_SLOT_CLOCK, nowWindow, reclaimWindow, releaseWindow, submitWindow, vectorSlotClock,
} from "../internal/window.js";

export interface IdentityEscrowAt {
  utxo: Utxo;
  datum: IdentityEscrowDatum;
}

interface SpendArgs {
  chain: ChainProvider;
  escrow: IdentityEscrowAt;
  /** Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
}

/** The blueprint, after checking that the escrow sits at the new escrow script. */
function blueprintFor(escrow: IdentityEscrowAt, given: IdentityBlueprint | undefined): IdentityBlueprint {
  const blueprint = given ?? loadIdentityBlueprint();
  if (!paidToScript(escrow.utxo.address, blueprint.escrowScriptHash)) {
    throw new TxConstructionError(
      "escrow layout mismatch",
      `${escrow.utxo.ref.txHash}#${escrow.utxo.ref.index}: a 16-field escrow datum must be at the new escrow script ${blueprint.escrowScriptHash}`,
    );
  }
  return blueprint;
}

/** Tip time and slot clock of the backend: live = wall clock on the Vector slots, mock = slot × 1000. */
async function chainTime(chain: ChainProvider): Promise<{ tipMs: number; clock: SlotConfig }> {
  const tipSlot = await chain.tip();
  return detectCborBackend(chain) === "live"
    ? { tipMs: Date.now(), clock: vectorSlotClock() }
    : { tipMs: mockSlotToWallclockMs(tipSlot), clock: MOCK_SLOT_CLOCK };
}

function escrowScript(blueprint: IdentityBlueprint): SpendPlan["script"] {
  return {
    compiledCode: blueprint.escrowCompiledCode,
    hash: blueprint.escrowScriptHash,
    address: (networkId) => blueprint.escrowScriptAddress(networkId),
    refEnvKey: "IDENTITY_ESCROW_REF_UTXO",
  };
}

function redeemer(value: EscrowRedeemer): SpendPlan["redeemer"] {
  return { name: value.type, hex: encodeEscrowRedeemer(value) };
}

function keyAddress(pkh: string): NetworkAddress {
  return (networkId) => pkhToEnterpriseAddress(pkh, networkId);
}

function atLeastFloor(lovelace: bigint): bigint {
  return lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : lovelace;
}

/**
 * A buyer payout (§6.1 rule 5): at exactly `refund.address` with exactly its
 * datum when `refund` is set, else at the enterprise address of `buyer_pkh`
 * (which every buyer-payout rule counts, also the one of RefundRevoked).
 */
function buyerPayout(datum: IdentityEscrowDatum, lovelace: bigint, assets: Record<string, bigint> = {}): PlannedOutput {
  const refund: Refund | null = datum.refund;
  if (refund === null) return { address: keyAddress(datum.buyer_pkh), lovelace, assets };
  return {
    address: (networkId) => plutusAddressToBech32(refund.address, networkId),
    lovelace,
    assets,
    datumHex: refund.datum === null ? null : encodePlutusDataHex(refund.datum),
  };
}

/** The continuing escrow output of Claim and Submit: same value, exact escrow address, inline datum. */
function continuing(blueprint: IdentityBlueprint, input: Utxo, datum: IdentityEscrowDatum): PlannedOutput {
  return {
    address: (networkId) => blueprint.escrowScriptAddress(networkId),
    lovelace: input.lovelace,
    assets: input.assets,
    datumHex: encodeIdentityEscrowDatum(datum),
    exactValue: true,
  };
}

/** The record of `agentId` from the caller's lookup, checked as `find_record` does. */
async function agentRecord(
  lookupRecord: RecordLookup | undefined,
  blueprint: IdentityBlueprint,
  agentId: string,
): Promise<{ utxo: Utxo; datum: IdentityDatum }> {
  if (lookupRecord === undefined) {
    throw new TxConstructionError("agent record lookup required", "an identity-layout escrow needs lookupRecord");
  }
  const utxo = await lookupRecord(agentId);
  const datum = readAgentRecord(utxo, blueprint.identityHash, agentId);
  return { utxo: utxo!, datum };
}

/**
 * The value cap of Claim (§6.1) and of Post (§6.5, F-29): payment, buyer bond
 * and supplier bond each at least 0, their sum at most 10,000 AP3X, and the
 * escrow output, when given, at most 10,005 AP3X.
 */
export function assertEscrowWithinCap(
  amounts: Pick<IdentityEscrowDatum, "payment_lovelace" | "buyer_bond_lovelace" | "supplier_bond_lovelace">,
  escrowLovelace?: bigint,
): void {
  const { payment_lovelace: payment, buyer_bond_lovelace: buyerBond, supplier_bond_lovelace: supplierBond } = amounts;
  if (payment < 0n || buyerBond < 0n || supplierBond < 0n) {
    throw new TxConstructionError(
      "negative escrow amount",
      `payment ${payment}, buyer bond ${buyerBond}, supplier bond ${supplierBond}`,
    );
  }
  const total = payment + buyerBond + supplierBond;
  if (total > MAX_ESCROW_LOVELACE) {
    throw new TxConstructionError("escrow above value cap", `payment + bonds = ${total} > ${MAX_ESCROW_LOVELACE}`);
  }
  if (escrowLovelace !== undefined && escrowLovelace > ESCROW_INPUT_CAP_LOVELACE) {
    throw new TxConstructionError("escrow input above cap", `escrow holds ${escrowLovelace} > ${ESCROW_INPUT_CAP_LOVELACE}`);
  }
}

/** The record condition of RefundRevoked (§6.1), from the record's own status. */
export function refundAllowed(datum: IdentityEscrowDatum, status: Status): boolean {
  switch (datum.state) {
    case "Open":
    case "Claimed":
      return status.type === "Revoked" || status.type === "Retired";
    case "Submitted":
      return status.type === "Revoked" && status.invalidFrom !== null && datum.submitted_at !== null &&
        status.invalidFrom <= datum.submitted_at;
    default:
      return false;
  }
}

export async function claimIdentity(args: SpendArgs & { supplierKey: WalletKey; lookupRecord?: RecordLookup }): Promise<BuildResult> {
  const { chain, escrow, supplierKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (supplierKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `supplierKey pkh ${supplierKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }
  if (datum.state !== "Open") {
    throw new TxConstructionError("wrong state", `expected Open for Claim, got ${datum.state}`);
  }
  const { tipMs, clock } = await chainTime(chain);
  if (tipMs >= datum.deliver_by) {
    throw new TxConstructionError("claim after deliver_by", `tip ${tipMs} >= deliver_by ${datum.deliver_by}`);
  }
  assertEscrowWithinCap(datum, escrow.utxo.lovelace);
  // hi = min(deliver_by, lo + 1 h); the record must be effectively Active over [lo, hi].
  const window = claimWindow(tipMs, datum.deliver_by, clock);
  const record = await agentRecord(args.lookupRecord, blueprint, datum.agent_id);
  assertAgentCanWork(record.datum, datum.agent_id, {
    keyHash: datum.supplier_pkh,
    capabilityId: datum.capability_id,
    lo: window.lo,
    hi: window.hi,
  });
  return submitSpend(chain, {
    action: "claim",
    redeemer: redeemer({ type: "Claim" }),
    walletKey: supplierKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [record.utxo],
    outputs: [continuing(blueprint, escrow.utxo, { ...datum, state: "Claimed" })],
    requiredSigners: [datum.supplier_pkh],
    window,
    reserveCollateral: false,
    beforeSubmit: args.beforeSubmit,
  });
}

export async function submitIdentity(
  args: SpendArgs & { supplierKey: WalletKey; receiptHash: string; lookupRecord?: RecordLookup },
): Promise<BuildResult> {
  const { chain, escrow, supplierKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (supplierKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `supplierKey pkh ${supplierKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }
  if (datum.state === "Submitted") {
    throw new TxConstructionError("double submit", "escrow already in Submitted state");
  }
  if (datum.state !== "Claimed") {
    throw new TxConstructionError("wrong state", `expected Claimed, got ${datum.state}`);
  }
  const { tipMs, clock } = await chainTime(chain);
  if (tipMs >= datum.deliver_by) {
    throw new TxConstructionError("submit after deliver_by", `tip ${tipMs} >= deliver_by ${datum.deliver_by}`);
  }
  // submitted_at = hi: the validator stores the upper bound of the range.
  const window = submitWindow(tipMs, datum.deliver_by, clock);
  const record = await agentRecord(args.lookupRecord, blueprint, datum.agent_id);
  assertAgentCanWork(record.datum, datum.agent_id, { keyHash: datum.supplier_pkh, lo: window.lo, hi: window.hi });
  const receiptHash = args.receiptHash.toLowerCase();
  return submitSpend(chain, {
    action: "submit",
    redeemer: redeemer({ type: "Submit", receipt_hash: receiptHash }),
    walletKey: supplierKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [record.utxo],
    outputs: [continuing(blueprint, escrow.utxo, {
      ...datum,
      state: "Submitted",
      submitted_at: window.hi,
      result_receipt_hash: receiptHash,
    })],
    requiredSigners: [datum.supplier_pkh],
    window,
    reserveCollateral: false,
    beforeSubmit: args.beforeSubmit,
  });
}

export async function acceptIdentity(
  args: SpendArgs & { buyerKey: WalletKey; excludeInputs?: readonly OutputReference[] },
): Promise<BuildResult> {
  const { chain, escrow, buyerKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (buyerKey.pubKeyHash !== datum.buyer_pkh) {
    throw new TxConstructionError(
      "buyer signature mismatch",
      `buyerKey pkh ${buyerKey.pubKeyHash} does not match datum.buyer_pkh ${datum.buyer_pkh}`,
    );
  }
  if (datum.state !== "Submitted") {
    throw new TxConstructionError("wrong state", `expected Submitted for Accept, got ${datum.state}`);
  }
  if (datum.submitted_at === null) {
    throw new TxConstructionError("submitted_at missing", "Submitted-state escrow must carry a submitted_at timestamp");
  }
  const { tipMs, clock } = await chainTime(chain);
  const windowEnd = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (tipMs > windowEnd) {
    throw new TxConstructionError("accept window expired", `tip ${tipMs} > submitted_at + ACCEPT_WINDOW = ${windowEnd}`);
  }
  // The buyer still signs Accept; the buyer bond goes to the refund address when it is set.
  return submitSpend(chain, {
    action: "accept",
    redeemer: redeemer({ type: "Accept" }),
    walletKey: buyerKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [],
    outputs: [
      {
        address: keyAddress(datum.supplier_pkh),
        lovelace: atLeastFloor(datum.payment_lovelace + datum.supplier_bond_lovelace),
      },
      buyerPayout(datum, atLeastFloor(datum.buyer_bond_lovelace)),
    ],
    requiredSigners: [datum.buyer_pkh],
    window: acceptWindow(tipMs, datum.submitted_at, clock),
    reserveCollateral: true,
    excludeInputs: args.excludeInputs,
    beforeSubmit: args.beforeSubmit,
  });
}

/**
 * Reclaim at or after deliver_by. Without `refund` the buyer signs and gets
 * payment + both bonds, as for the legacy escrow. With `refund`, any wallet
 * can submit it, no buyer signature is needed, and the whole escrow value
 * goes to the refund address with exactly the refund datum: the contract
 * requires the AP3X and every other asset of the escrow input there.
 */
export async function reclaimIdentity(args: SpendArgs & { walletKey: WalletKey }): Promise<BuildResult> {
  const { chain, escrow, walletKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (datum.refund === null && walletKey.pubKeyHash !== datum.buyer_pkh) {
    throw new TxConstructionError(
      "buyer signature mismatch",
      `buyerKey pkh ${walletKey.pubKeyHash} does not match datum.buyer_pkh ${datum.buyer_pkh}`,
    );
  }
  if (datum.state !== "Open" && datum.state !== "Claimed") {
    throw new TxConstructionError("wrong state", `expected Open or Claimed for Reclaim, got ${datum.state}`);
  }
  const { tipMs, clock } = await chainTime(chain);
  if (tipMs < datum.deliver_by) {
    throw new TxConstructionError("reclaim before deliver_by", `tip ${tipMs} < deliver_by ${datum.deliver_by}`);
  }
  const fullRefund = datum.refund !== null;
  return submitSpend(chain, {
    action: "reclaim",
    redeemer: redeemer({ type: "Reclaim" }),
    walletKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [],
    outputs: [
      fullRefund
        ? buyerPayout(datum, escrow.utxo.lovelace, escrow.utxo.assets)
        : buyerPayout(datum, atLeastFloor(datum.payment_lovelace + datum.buyer_bond_lovelace + datum.supplier_bond_lovelace)),
    ],
    requiredSigners: fullRefund ? [] : [datum.buyer_pkh],
    window: reclaimWindow(tipMs, datum.deliver_by, clock),
    reserveCollateral: true,
    beforeSubmit: args.beforeSubmit,
  });
}

export async function releaseIdentity(args: SpendArgs & { supplierKey: WalletKey }): Promise<BuildResult> {
  const { chain, escrow, supplierKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (supplierKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `supplierKey pkh ${supplierKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }
  if (datum.state !== "Submitted") {
    throw new TxConstructionError("wrong state", `expected Submitted for Release, got ${datum.state}`);
  }
  if (datum.submitted_at === null) {
    throw new TxConstructionError("submitted_at missing", "Submitted-state escrow must carry a submitted_at timestamp");
  }
  const { tipMs, clock } = await chainTime(chain);
  const threshold = datum.submitted_at + ACCEPT_WINDOW_MS;
  if (tipMs < threshold) {
    throw new TxConstructionError("release before accept window", `tip ${tipMs} < submitted_at + ACCEPT_WINDOW = ${threshold}`);
  }
  return submitSpend(chain, {
    action: "release",
    redeemer: redeemer({ type: "Release" }),
    walletKey: supplierKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [],
    outputs: [{
      address: keyAddress(datum.supplier_pkh),
      lovelace: atLeastFloor(datum.payment_lovelace + datum.supplier_bond_lovelace + datum.buyer_bond_lovelace),
    }],
    requiredSigners: [datum.supplier_pkh],
    window: releaseWindow(tipMs, datum.submitted_at, clock),
    reserveCollateral: false,
    beforeSubmit: args.beforeSubmit,
  });
}

/**
 * RefundRevoked: any wallet, before or after deliver_by, when the agent's
 * record allows it (refundAllowed). The whole escrow value goes to the refund
 * address with exactly the refund datum, or to the enterprise address of
 * buyer_pkh when `refund` is not set: the contract requires the AP3X and
 * every other asset of the escrow input there.
 */
export async function refundRevokedIdentity(
  args: SpendArgs & { walletKey: WalletKey; lookupRecord?: RecordLookup; excludeInputs?: readonly OutputReference[] },
): Promise<BuildResult> {
  const { chain, escrow, walletKey } = args;
  const datum = escrow.datum;
  const blueprint = blueprintFor(escrow, args.identityBlueprint);
  if (datum.state !== "Open" && datum.state !== "Claimed" && datum.state !== "Submitted") {
    throw new TxConstructionError("wrong state", `expected Open, Claimed or Submitted for RefundRevoked, got ${datum.state}`);
  }
  const record = await agentRecord(args.lookupRecord, blueprint, datum.agent_id);
  if (!refundAllowed(datum, record.datum.status)) {
    const status = record.datum.status;
    const invalidFrom = status.type === "Revoked" ? `, invalid_from ${status.invalidFrom ?? "none"}` : "";
    throw new TxConstructionError(
      "refund not allowed",
      `escrow ${datum.state} (submitted_at ${datum.submitted_at ?? "none"}), record ${status.type}${invalidFrom}`,
    );
  }
  const { tipMs, clock } = await chainTime(chain);
  return submitSpend(chain, {
    action: "refund-revoked",
    redeemer: redeemer({ type: "RefundRevoked" }),
    walletKey,
    input: escrow.utxo,
    script: escrowScript(blueprint),
    referenceInputs: [record.utxo],
    outputs: [buyerPayout(datum, escrow.utxo.lovelace, escrow.utxo.assets)],
    requiredSigners: [],
    window: nowWindow(tipMs, clock),
    reserveCollateral: true,
    excludeInputs: args.excludeInputs,
    beforeSubmit: args.beforeSubmit,
  });
}
