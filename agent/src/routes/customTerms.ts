/**
 * agent/src/routes/customTerms.ts — the escrow against the advert of this node.
 *
 * A buyer that builds its own escrow can write any numbers in the datum and
 * lock any amount. The advert on the chain is what this node offers. The route
 * calls `escrowTermsRefusal` before the Claim, so a refused job costs no Claim
 * and the escrow stays Open.
 *
 * The rules, in this order. Each one has its own code:
 *
 *   wrong_advert   The escrow names another advert than the one this node
 *                  serves (ADVERT_REF).
 *   underpaid      The payment of the escrow is below the advert price.
 *   bond_mismatch  A bond of the escrow is below the advert bond.
 *   underpaid      The escrow output holds less than the payment and both
 *                  bonds of its datum. The datum alone proves nothing: the
 *                  amount that the output holds is the amount that settles.
 *
 * A payment or a bond above the advert is not refused. The supplier gets more,
 * not less. The hosted builder of a payment from a vault adds the lock floor
 * (the minimum ada of the output) to the buyer bond, so a buyer bond above the
 * advert bond is normal.
 */

import type { OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";

export type TermsRefusalCode = "wrong_advert" | "underpaid" | "bond_mismatch";

export interface TermsRefusal {
  status: 409;
  code: TermsRefusalCode;
  message: string;
}

export interface EscrowTerms {
  escrow: Pick<EscrowDatum, "advert_ref" | "payment_lovelace" | "buyer_bond_lovelace" | "supplier_bond_lovelace">;
  /** The lovelace that the escrow output holds. */
  held: bigint;
  advert: Pick<AdvertDatum, "price_lovelace" | "buyer_bond_lovelace" | "supplier_bond_lovelace">;
  /** The advert that this node serves. */
  advertRef: OutputReference;
}

const refText = (ref: OutputReference): string => `${ref.txHash.toLowerCase()}#${ref.index}`;

/** The first rule that the escrow breaks, or null. */
export function escrowTermsRefusal({ escrow, held, advert, advertRef }: EscrowTerms): TermsRefusal | null {
  const refuse = (code: TermsRefusalCode, message: string): TermsRefusal => ({ status: 409, code, message });

  if (refText(escrow.advert_ref) !== refText(advertRef)) {
    return refuse("wrong_advert",
      `The escrow names advert ${refText(escrow.advert_ref)}. This node serves advert ${refText(advertRef)}.`);
  }
  if (escrow.payment_lovelace < advert.price_lovelace) {
    return refuse("underpaid",
      `The payment of the escrow (${escrow.payment_lovelace} lovelace) is below the advert price (${advert.price_lovelace} lovelace).`);
  }
  if (escrow.buyer_bond_lovelace < advert.buyer_bond_lovelace) {
    return refuse("bond_mismatch",
      `The buyer bond of the escrow (${escrow.buyer_bond_lovelace} lovelace) is below the advert bond (${advert.buyer_bond_lovelace} lovelace).`);
  }
  if (escrow.supplier_bond_lovelace < advert.supplier_bond_lovelace) {
    return refuse("bond_mismatch",
      `The supplier bond of the escrow (${escrow.supplier_bond_lovelace} lovelace) is below the advert bond (${advert.supplier_bond_lovelace} lovelace).`);
  }
  const locked = escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace;
  if (held < locked) {
    return refuse("underpaid",
      `The escrow output holds ${held} lovelace. The payment and both bonds need ${locked} lovelace.`);
  }
  return null;
}
