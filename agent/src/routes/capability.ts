/**
 * supplier/src/routes/capability.ts — GET /capability handler.
 *
 * Reads the configured ADVERT_REF from chain via chain.queryUtxo.
 * Returns the decoded AdvertDatum plus advert_ref and supplier_pkh.
 * Response headers: Cache-Control: no-store
 *
 * Error cases:
 *   503 — advert UTxO not found
 *   503 — datum.status !== "Active"
 *
 * Stub — throws until M1-C-green implementation lands.
 */

export {};
