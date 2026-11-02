/**
 * tx/internal/layout.ts — the legacy and identity layouts of escrows and
 * adverts during the drain (Part 2 §6.5, §9.6).
 *
 * The datum decides the layout: 14 escrow fields (13 advert fields) are the
 * legacy layout, 16 escrow fields (14 advert fields) the identity layout
 * (agent_id, and refund for an escrow). A legacy datum keeps the legacy
 * decoder and the legacy builder path unchanged. An identity escrow or advert
 * must sit at the new script, because only that script accepts its datum.
 */

import type { ChainProvider, OutputReference, Utxo } from "../../chain/ChainProvider.js";
import type { AdvertDatum, EscrowDatum } from "../../cbor/types.js";
import { decodeAdvertDatum } from "../../cbor/AdvertDatum.js";
import { decodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import { decodeAnyEscrowDatum, type AnyEscrowDatum, type IdentityEscrowDatum } from "../../cbor/IdentityEscrowDatum.js";
import { decodeAnyAdvertDatum, type AnyAdvertDatum, type IdentityAdvertDatum } from "../../cbor/IdentityAdvertDatum.js";
import { plutusAddressFromBech32 } from "../../cbor/address.js";
import { TxConstructionError } from "../types.js";

/** The escrow and advert layouts of the drain. */
export type MarketplaceLayout = "legacy" | "identity";

/** A datum with `agent_id` is the identity layout. */
export function isIdentityEscrowDatum(datum: EscrowDatum | IdentityEscrowDatum): datum is IdentityEscrowDatum {
  return "agent_id" in datum && typeof datum.agent_id === "string";
}

/** A datum with `agent_id` is the identity layout. */
export function isIdentityAdvertDatum(datum: AdvertDatum | IdentityAdvertDatum): datum is IdentityAdvertDatum {
  return "agent_id" in datum && typeof datum.agent_id === "string";
}

export type EscrowAt = AnyEscrowDatum & { utxo: Utxo };
export type AdvertAt = AnyAdvertDatum & { utxo: Utxo };

/**
 * The escrow output at `ref` and its datum in either layout. Throws
 * TxConstructionError "escrow ref not on chain" or "escrow datum missing";
 * a datum that no layout accepts throws the legacy decoder's error.
 */
export async function readEscrow(chain: ChainProvider, ref: OutputReference): Promise<EscrowAt> {
  const utxo = await chain.queryUtxo(ref);
  if (utxo === null) {
    throw new TxConstructionError("escrow ref not on chain", `no UTxO at ${ref.txHash}#${ref.index}`);
  }
  if (!utxo.datumHex) {
    throw new TxConstructionError("escrow datum missing", `UTxO ${ref.txHash}#${ref.index} has no inline datum`);
  }
  let any: AnyEscrowDatum;
  try {
    any = decodeAnyEscrowDatum(utxo.datumHex);
  } catch {
    any = { layout: "legacy", datum: decodeEscrowDatum(utxo.datumHex) };
  }
  return { ...any, utxo };
}

/**
 * The advert output at `ref` and its datum in either layout. Throws
 * TxConstructionError "advert ref not on chain" or "advert datum missing";
 * a datum that no layout accepts throws the legacy decoder's error.
 */
export async function readAdvert(chain: ChainProvider, ref: OutputReference): Promise<AdvertAt> {
  const utxo = await chain.queryUtxo(ref);
  if (utxo === null) {
    throw new TxConstructionError("advert ref not on chain", `no UTxO at ${ref.txHash}#${ref.index}`);
  }
  if (!utxo.datumHex) {
    throw new TxConstructionError("advert datum missing", `UTxO ${ref.txHash}#${ref.index} has no inline datum`);
  }
  let any: AnyAdvertDatum;
  try {
    any = decodeAnyAdvertDatum(utxo.datumHex);
  } catch {
    any = { layout: "legacy", datum: decodeAdvertDatum(utxo.datumHex) };
  }
  return { ...any, utxo };
}

/** True when the payment credential of the bech32 `address` is Script(scriptHash), on any network. */
export function paidToScript(address: string, scriptHash: string): boolean {
  try {
    const { paymentCredential } = plutusAddressFromBech32(address);
    return paymentCredential.type === "Script" && paymentCredential.hash === scriptHash;
  } catch {
    return false;
  }
}
