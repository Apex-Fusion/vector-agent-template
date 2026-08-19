/**
 * tx/internal/cborBackend.ts — detect which CBOR backend to use for tx building.
 *
 * "live" → use lucid-evolution to produce real Cardano CBOR (M1-F-4).
 * "mock" → use synthetic testTxBody JSON-in-hex (all non-Live providers).
 *
 * The dispatch is a single instanceof LiveOgmiosProvider check. Mock and
 * read-only providers fall through to the synthetic-CBOR mock path.
 */

import type { ChainProvider } from "../../chain/ChainProvider.js";
import { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";

export type CborBackend = "mock" | "live";

export function detectCborBackend(chain: ChainProvider): CborBackend {
  return chain instanceof LiveOgmiosProvider ? "live" : "mock";
}
