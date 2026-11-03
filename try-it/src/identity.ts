/**
 * try-it/src/identity.ts — the buyer's side of the advert and escrow layouts
 * that carry an `agent_id` (the identity registry plan of the upstream
 * repository, docs/IDENTITY_REGISTRY.md §6.1–§6.4 and §9.6).
 *
 * During the drain both layouts exist. A 13-field advert and a 14-field escrow
 * are the legacy layout. A 14-field advert and a 16-field escrow carry
 * `agent_id`, and the escrow also a `refund` address. The advert decides
 * which escrow a Post creates. From the switch slot on, builders create new
 * escrows only, so a legacy advert is refused (`escrowLayout`).
 *
 * A Post on an advert with `agent_id` must pass the listing rule (§6.2). The
 * vendored Post builder checks it through two lookups, built here the way the
 * upstream buyer SDK builds them (buyer/src/sdk/identity.ts):
 *   - lookupRecord: the agent's record output at the identity address, read
 *     from Ogmios. The builder checks that output as the escrow contract does.
 *   - lookupAdvertSigners: the indexer listing (GET /suppliers). Ogmios cannot
 *     return the transaction that created the advert. The indexer lists a new
 *     advert only when that transaction carries the supplier key as a
 *     required signer and the agent's record passes the listing rule.
 */

import type { ChainProvider, Utxo } from "@marketplace/shared/chain";
import {
  decodeAdvertDatum,
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  decodeEscrowDatum,
  type AnyAdvertDatum,
  type AnyEscrowDatum,
} from "@marketplace/shared/cbor";
import {
  TxConstructionError,
  type AdvertSignersLookup,
  type IdentityBlueprint,
  type MarketplaceLayout,
  type RecordLookup,
} from "@marketplace/shared/tx";

/** The public marketplace indexer on Vector mainnet. INDEXER_URL overrides it. */
export const MAINNET_INDEXER_URL = "https://mp-indexer.vector.apexfusion.org";

/** Client budget for one GET /suppliers. */
const INDEXER_TIMEOUT_MS = 30_000;

/** The advert datum in either layout. A datum that no layout accepts throws the legacy decoder's error. */
export function decodeAdvert(datumHex: string): AnyAdvertDatum {
  try {
    return decodeAnyAdvertDatum(datumHex);
  } catch {
    return { layout: "legacy", datum: decodeAdvertDatum(datumHex) };
  }
}

/** The escrow datum in either layout, with the same legacy fallback as decodeAdvert. */
export function decodeEscrow(datumHex: string): AnyEscrowDatum {
  try {
    return decodeAnyEscrowDatum(datumHex);
  } catch {
    return { layout: "legacy", datum: decodeEscrowDatum(datumHex) };
  }
}

/**
 * The layout a Post must create (§9.6): "identity" from `switchSlot` on (the
 * vendored builder then refuses a legacy advert), undefined before it or
 * without a switch slot (the advert decides).
 */
export function postLayout(tipSlot: number, switchSlot: number | null): MarketplaceLayout | undefined {
  return switchSlot !== null && tipSlot >= switchSlot ? "identity" : undefined;
}

/**
 * The record output of an agent: the output at the identity address (on
 * `networkId`) that holds the token identity_hash + agent_id. The builder
 * checks the output it gets (authentic, independent, Active, key, capability),
 * so this lookup only finds it.
 */
export function chainRecordLookup(chain: ChainProvider, blueprint: IdentityBlueprint, networkId: 0 | 1): RecordLookup {
  return async (agentId: string): Promise<Utxo | null> => {
    const unit = `${blueprint.identityHash}${agentId}`;
    const outputs = await chain.queryUtxosByAddress(blueprint.identityScriptAddress(networkId));
    // Ogmios writes units as "policy.name"; other providers as "policyname".
    return outputs.find((utxo) => Object.entries(utxo.assets)
      .some(([key, quantity]) => quantity > 0n && key.toLowerCase().replace(".", "") === unit)) ?? null;
  };
}

/** GET a URL and parse its JSON body. Replaceable in tests. */
export type GetJson = (url: string) => Promise<unknown>;

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(INDEXER_TIMEOUT_MS) });
  } catch (err) {
    throw new TxConstructionError("indexer unavailable", `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new TxConstructionError("indexer unavailable", `${url} returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new TxConstructionError("indexer unavailable", `${url} returned a body that is not JSON`);
  }
}

/**
 * The signers of the transaction that created a new advert, from the indexer
 * listing (§6.2, §6.4). A listed row gives `[supplier_pkh]` when its
 * `agent_id` and `supplier_pkh` equal the advert datum on chain, so the Post
 * copies `agent_id` only from a listed advert. Throws TxConstructionError
 * "advert not listed" otherwise, and "indexer unavailable" when the listing
 * cannot be read.
 */
export function indexerAdvertSigners(
  chain: ChainProvider,
  indexerUrl: string,
  get: GetJson = getJson,
): AdvertSignersLookup {
  return async (advertRef) => {
    const ref = `${advertRef.txHash}#${advertRef.index}`;
    const listing = await get(`${indexerUrl}/suppliers`);
    if (!Array.isArray(listing)) {
      throw new TxConstructionError("indexer unavailable", `${indexerUrl}/suppliers did not return a list`);
    }
    const row = listing.find((value): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && (value as Record<string, unknown>).utxo_ref === ref);
    const agentId = row?.agent_id;
    const supplierPkh = row?.supplier_pkh;
    if (typeof agentId !== "string" || typeof supplierPkh !== "string") {
      throw new TxConstructionError(
        "advert not listed",
        `the indexer at ${indexerUrl} does not list ${ref} as an advert with an agent_id`,
      );
    }
    const utxo = await chain.queryUtxo(advertRef);
    const advert = utxo?.datumHex ? decodeAdvert(utxo.datumHex) : null;
    if (advert?.layout !== "identity" || advert.datum.agent_id !== agentId || advert.datum.supplier_pkh !== supplierPkh) {
      throw new TxConstructionError(
        "advert not listed",
        `the indexer lists ${ref} for agent ${agentId} and supplier ${supplierPkh}, which the advert on chain does not name`,
      );
    }
    return [supplierPkh];
  };
}
