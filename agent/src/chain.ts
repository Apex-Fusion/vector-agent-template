/**
 * supplier/src/chain.ts — Provider construction for the supplier boot path.
 *
 * Exports `buildChainProvider(config, fetch?)` which returns either:
 *   - LiveOgmiosProvider  when config.liveChain === true
 *   - ReadOnlyOgmiosProvider  otherwise (default, safe)
 *
 * The function is extracted from index.ts so it can be tested in isolation
 * without booting the entire Express server.
 *
 * LIVE_CHAIN contract (from config.ts):
 *   - Only the literal string "1" opts in to live-chain mode.
 *   - "true", "yes", "TRUE", "0", "" all default to ReadOnly.
 *   - Default is ReadOnly for safety (real testnet/mainnet submissions
 *     require explicit opt-in).
 */

import {
  LiveOgmiosProvider,
  ReadOnlyOgmiosProvider,
  type ChainProvider,
} from "@marketplace/shared/chain";
import type { SupplierConfig } from "./config.js";

/**
 * Build the appropriate ChainProvider based on config.liveChain.
 *
 * @param config   Loaded SupplierConfig (must include liveChain field).
 * @param fetchFn  Optional fetch override; defaults to globalThis.fetch.
 *                 Injected by tests to avoid real network calls.
 */
export function buildChainProvider(
  config: SupplierConfig,
  fetchFn?: typeof globalThis.fetch,
): ChainProvider {
  const opts = { ogmiosUrl: config.ogmiosUrl, fetch: fetchFn };
  if (config.liveChain) {
    // eslint-disable-next-line no-console
    console.log("chain: LiveOgmiosProvider selected (LIVE_CHAIN=1)");
    return new LiveOgmiosProvider(opts);
  }
  // eslint-disable-next-line no-console
  console.log("chain: ReadOnlyOgmiosProvider selected (LIVE_CHAIN unset)");
  return new ReadOnlyOgmiosProvider({ ogmiosUrl: config.ogmiosUrl });
}
