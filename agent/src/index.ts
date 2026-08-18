/**
 * supplier/src/index.ts — Supplier-node entry point.
 *
 * Loads config from process.env, instantiates state + chain provider,
 * boots the Express app, and installs graceful shutdown.
 *
 * Run:
 *   node --experimental-strip-types supplier/src/index.ts
 *   (or via tsx for dev)
 *
 * Environment variables: see ./config.ts.
 *
 * For M1-C the chain provider here defaults to the read-only Ogmios
 * provider — it can read UTxOs and tip but not submit. Tier 3 (live)
 * wiring lands in M1-D when tx-submit harness is ready. Tests bypass
 * this entry point entirely and call createApp(deps) directly.
 */

import { loadConfig } from "./config.js";
import { SupplierState } from "./state.js";
import { JobStore } from "./jobs.js";
import { createApp, type SupplierDeps } from "./server.js";
import { buildChainProvider } from "./chain.js";
import { startWalletHealthTicker } from "./walletHealth.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);

  // Derive a WalletKey from the configured private key. v1 receipt-signing
  // uses the same key as on-chain signing — see ARCHITECTURE.md §9 open
  // follow-up (sub-keys are a future tightening, not v1).
  // Public key + pkh are NOT derived here yet: M1-D will plug in the proper
  // Ed25519 + blake2b-224 pipeline. For boot correctness today we read them
  // from optional env vars; tests inject WalletKey directly.
  const supplierKey = {
    privateKeyHex: cfg.supplierPrivKeyHex,
    pubKeyHex: process.env.SUPPLIER_PUB_KEY_HEX ?? "",
    pubKeyHash: process.env.SUPPLIER_PKH ?? "",
    address: process.env.SUPPLIER_ADDRESS ?? "",
  };

  // M1-F-2: provider selection is driven by cfg.liveChain (LIVE_CHAIN=1).
  // ReadOnly is the safe default; live mode is explicit opt-in.
  const chain = buildChainProvider(cfg);
  // chat-session kind serves N concurrent sessions; one-shot kinds stay 1.
  const state = new SupplierState(cfg.capabilityKind === "chat-session" ? cfg.maxChatSessions : 1);
  const jobs = new JobStore();

  const deps: SupplierDeps = { chain, state, config: cfg, supplierKey, jobs };
  const app = createApp(deps);

  const server = app.listen(cfg.port, () => {
    // eslint-disable-next-line no-console
    console.log(`supplier listening on :${cfg.port}`);
  });

  // M1-F-async-chat: evict expired terminal jobs every 60s (TTL = 10min).
  // .unref() prevents the timer from keeping the event loop alive after
  // server.close() during shutdown.
  const evictInterval = setInterval(
    () => jobs.evictExpired(Date.now()),
    60_000,
  );
  evictInterval.unref();

  // Wallet self-consolidation: only meaningful when chain writes are enabled.
  // 0 disables. planConsolidate short-circuits to already-healthy in the
  // common case so this is a no-op on a clean wallet.
  const walletHealthTicker =
    cfg.liveChain && cfg.walletHealthIntervalMs > 0
      ? startWalletHealthTicker(
          { chain, state, supplierKey },
          { intervalMs: cfg.walletHealthIntervalMs },
        )
      : null;

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`received ${signal}, shutting down`);
    clearInterval(evictInterval);
    walletHealthTicker?.stop();
    state.markOffline();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only run when executed directly (not when imported by tests).
const isDirectRun = process.argv[1]?.endsWith("supplier/src/index.ts")
  || process.argv[1]?.endsWith("supplier/dist/index.js");
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("supplier boot failed:", err);
    process.exit(1);
  });
}

export { main };
