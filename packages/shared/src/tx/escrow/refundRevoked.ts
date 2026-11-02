/**
 * tx/escrow/refundRevoked.ts — builds a RefundRevoked transaction (new escrow
 * only, Part 2 §6.1).
 *
 * Any wallet key can submit it, before or after deliver_by; the wallet pays
 * the fee and the collateral and needs no role in the escrow. It applies:
 *   - when the escrow is Open or Claimed and the agent record is Revoked or
 *     Retired; or
 *   - when the escrow is Submitted and the record is Revoked with
 *     invalid_from ≤ submitted_at.
 * The whole escrow value goes to refund.address with exactly the refund
 * datum, or to the enterprise address of buyer_pkh when `refund` is not set.
 * The agent record is a reference input (`lookupRecord`). A legacy escrow has
 * no RefundRevoked: the builder refuses it.
 */

import type { ChainProvider, OutputReference } from "../../chain/ChainProvider.js";
import type { IdentityBlueprint } from "../blueprint.js";
import type { RecordLookup } from "../identityRecord.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { readEscrow } from "../internal/layout.js";
import { refundRevokedIdentity } from "./identityEscrow.js";

export interface RefundRevokedParams {
  chain: ChainProvider;
  /** Any wallet key: it signs, and pays the fee and the collateral. */
  walletKey: WalletKey;
  escrowRef: OutputReference;
  /** Finds the agent record of the escrow's agent_id. */
  lookupRecord: RecordLookup;
  /** Default: loadIdentityBlueprint() (env IDENTITY_POLICY_ID). */
  identityBlueprint?: IdentityBlueprint;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
  /** Wallet outputs that a submitted, unconfirmed transaction spends; never selected (live backend). */
  excludeInputs?: readonly OutputReference[];
}

export async function buildRefundRevokedTx(params: RefundRevokedParams): Promise<BuildResult> {
  const escrow = await readEscrow(params.chain, params.escrowRef);
  if (escrow.layout !== "identity") {
    throw new TxConstructionError(
      "escrow layout mismatch",
      "RefundRevoked exists only for the new escrow (16-field datum)",
    );
  }
  return refundRevokedIdentity({
    chain: params.chain,
    escrow,
    walletKey: params.walletKey,
    lookupRecord: params.lookupRecord,
    identityBlueprint: params.identityBlueprint,
    beforeSubmit: params.beforeSubmit,
    excludeInputs: params.excludeInputs,
  });
}
