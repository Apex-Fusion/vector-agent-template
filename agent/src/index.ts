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
import { decodeAdvert, ownAgentId, supplierIdentity } from "./identity/agent.js";
import { BOUNDED_INPUT_DETAIL_MARKER } from "@marketplace/shared/tx";
import { OpenRouterCapacityProvider } from "./reseller/openRouterCapacity.js";
import { CapacityGate } from "./reseller/capacityGate.js";
import { ResellerEvidenceStore } from "./reseller/evidenceStore.js";
import { ResellerRuntime } from "./reseller/runtime.js";
import { deriveSupplierKey } from "./paper2agent/identity.js";
import { Paper2AgentRuntime } from "./paper2agent/runtime.js";

async function main(): Promise<void> {
  const cfg = loadConfig(process.env);

  // Tool suppliers bind the actual signing key to every advertised identity.
  // Keep the existing injected identities for other capability kinds.
  const supplierKey = cfg.capabilityKind === "paper2agent"
    ? deriveSupplierKey(cfg.supplierPrivKeyHex, cfg.networkId)
    : {
    privateKeyHex: cfg.supplierPrivKeyHex,
    pubKeyHex: process.env.SUPPLIER_PUB_KEY_HEX ?? "",
    pubKeyHash: process.env.SUPPLIER_PKH ?? "",
    address: process.env.SUPPLIER_ADDRESS ?? "",
  };
  if (cfg.capabilityKind === "paper2agent") {
    for (const [name, derived] of [
      ["SUPPLIER_PUB_KEY_HEX", supplierKey.pubKeyHex],
      ["SUPPLIER_PKH", supplierKey.pubKeyHash],
      ["SUPPLIER_ADDRESS", supplierKey.address],
    ]) {
      if (process.env[name] && process.env[name] !== derived) {
        throw new Error(`${name} does not match the supplier signing key`);
      }
    }
  }

  // M1-F-2: provider selection is driven by cfg.liveChain (LIVE_CHAIN=1).
  // ReadOnly is the safe default; live mode is explicit opt-in.
  const chain = buildChainProvider(cfg);
  // Record lookup and identity blueprint for new escrows; the blueprint loads on first use.
  const identity = supplierIdentity(chain, cfg.networkId);
  // chat-session kind serves N concurrent sessions; one-shot kinds stay 1.
  const state = new SupplierState(cfg.capabilityKind === "chat-session" ? cfg.maxChatSessions : 1);
  const jobs = new JobStore();
  const paper2agent = cfg.capabilityKind === "paper2agent"
    ? await Paper2AgentRuntime.create({ chain, state, supplierKey, networkId: cfg.networkId,
      advertRef: cfg.advertRef, config: cfg.paper2agent!, agentId: cfg.agentId, identity })
    : undefined;
  let reseller: ResellerRuntime | undefined;
  if (cfg.reseller) {
    const advertUtxo = await chain.queryUtxo(cfg.advertRef);
    if (!advertUtxo?.datumHex) {
      throw new Error("reseller boot: configured advert UTxO is unavailable");
    }
    const advert = decodeAdvert(advertUtxo.datumHex).datum;
    // Throws when AGENT_ID and a new advert name different agents.
    ownAgentId(cfg.agentId, advert);
    if (advert.status !== "Active") {
      throw new Error(`reseller boot: advert status is ${advert.status}`);
    }
    if (advert.capability_id !== "llm.text.generate.v1") {
      throw new Error(
        `reseller boot: advert capability must be llm.text.generate.v1, got ${advert.capability_id}`,
      );
    }
    if (!advert.detail_uri.endsWith(BOUNDED_INPUT_DETAIL_MARKER)) {
      throw new Error("reseller boot: advert is missing bounded-input metadata");
    }
    if (advert.max_output_tokens !== cfg.openaiMaxTokens) {
      throw new Error(
        "reseller boot: OPENAI_MAX_TOKENS must equal advert max_output_tokens",
      );
    }
    if (advert.supplier_pkh !== supplierKey.pubKeyHash) {
      throw new Error("reseller boot: advert supplier does not match SUPPLIER_PKH");
    }

    const providerModel = cfg.openaiModelOverride || advert.model;
    const provider = new OpenRouterCapacityProvider({
      baseUrl: cfg.openaiBaseUrl,
      apiKey: cfg.openaiApiKey,
      timeoutMs: cfg.reseller.providerTimeoutMs,
    });
    const gate = new CapacityGate({
      provider,
      model: providerModel,
      reserveUsd: cfg.reseller.reserveUsd,
      maxInputTokens: cfg.reseller.maxInputTokens,
      maxOutputTokens: advert.max_output_tokens,
      staleAfterMs: cfg.reseller.staleAfterMs,
    });
    const store = new ResellerEvidenceStore(
      cfg.reseller.databaseUrl,
      cfg.reseller.previewMaxChars,
    );
    reseller = new ResellerRuntime({
      chain,
      state,
      gate,
      store,
      advert,
      advertRef: cfg.advertRef,
      providerModel,
      pollIntervalMs: cfg.reseller.pollIntervalMs,
      maxInputTokens: cfg.reseller.maxInputTokens,
    });
    await reseller.initialize();
  }


  const deps: SupplierDeps = {
    chain,
    state,
    config: cfg,
    supplierKey,
    jobs,
    reseller,
    paper2agent,
    identity,
  };
  const app = createApp(deps);

  const onListening = () => {
    // eslint-disable-next-line no-console
    console.log(`supplier listening on ${cfg.bindHost ?? ""}:${cfg.port}`);
  };
  const server = cfg.bindHost
    ? app.listen(cfg.port, cfg.bindHost, onListening)
    : app.listen(cfg.port, onListening);

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
    const runtimeCleanup = Promise.all([reseller?.close(), paper2agent?.close()])
      .then(() => 0, () => 1);
    server.close(() => {
      void runtimeCleanup.then((code) => process.exit(code));
    });
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// Only run when executed directly (not when imported by tests). Matches both
// the pre-rename "supplier/" path (upstream) and the "agent/" path this
// template renames it to, so main() runs under either tree shape. Windows
// reports argv[1] with backslashes, which never matches these forward-slash
// suffixes as-is - normalize separators before comparing so the gate also
// fires when run directly on a Windows dev box, not only inside Docker/Linux.
const normalizedArgv1 = process.argv[1]?.replace(/\\/g, "/");
const isDirectRun = normalizedArgv1?.endsWith("supplier/src/index.ts")
  || normalizedArgv1?.endsWith("supplier/dist/index.js")
  || normalizedArgv1?.endsWith("agent/src/index.ts")
  || normalizedArgv1?.endsWith("agent/dist/index.js");
if (isDirectRun) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("supplier boot failed:", err);
    process.exit(1);
  });
}

export { main };
