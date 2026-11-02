import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { loadSurplusManagerConfig } from "../surplus/config.js";
import { SurplusClient, type SurplusSale } from "../surplus/client.js";
import { SurplusSellerController } from "../surplus/controller.js";
import { OpenRouterKeyClient } from "../surplus/openRouterKey.js";
import { FileSurplusStateStore } from "../surplus/state.js";
import {
  SurplusDashboardService,
  type SurplusDashboardSnapshot,
} from "../surplus/dashboard.js";
import { FileSurplusVectorProofLedger } from "../surplus/vectorProof.js";
import { loadHistoricalSalesCsv } from "../surplus/historyExport.js";
import { SurplusVectorProofPublisher } from "../surplus/vectorPublisher.js";
import { LiveOgmiosProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import { buildAnchorMetadataTx } from "@marketplace/shared/tx/server";
import { deriveKeypair } from "./gen-keypair.js";

export async function runSurplusSeller(
  env: Record<string, string | undefined>,
): Promise<{
  server: Server;
  controller: SurplusSellerController;
  publisher: SurplusVectorProofPublisher | null;
}> {
  const config = loadSurplusManagerConfig(env);
  const client = new SurplusClient({
    apiBaseUrl: config.apiBaseUrl,
    sellerApiKey: config.sellerApiKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const allowance = new OpenRouterKeyClient({
    baseUrl: config.capacityBaseUrl,
    apiKey: config.providerApiKey,
    timeoutMs: config.requestTimeoutMs,
  });
  const stateStore = new FileSurplusStateStore(config.statePath);
  const controller = new SurplusSellerController({
    config,
    client,
    allowance,
    stateStore,
    log: (message) => console.log(message),
  });

  let publisher: SurplusVectorProofPublisher | null = null;
  let proofs: FileSurplusVectorProofLedger | undefined;
  if (config.proof !== null) {
    const proofConfig = config.proof;
    const ledger = await FileSurplusVectorProofLedger.open(proofConfig.ledgerPath);
    proofs = ledger;
    const chain = new LiveOgmiosProvider({ ogmiosUrl: proofConfig.ogmiosUrl });
    const derived = deriveKeypair(proofConfig.walletPrivateKeyHex, 1);
    const walletKey: WalletKey = {
      pubKeyHash: derived.pubKeyHash,
      pubKeyHex: derived.publicKeyHex,
      privateKeyHex: derived.privateKeyHex,
      address: derived.address,
    };

    let historicalSales: (() => Promise<readonly SurplusSale[]>) | undefined;
    if (proofConfig.historyCsvPath !== null && proofConfig.historyOfferId !== null) {
      const history = await loadHistoricalSalesCsv(
        proofConfig.historyCsvPath,
        proofConfig.historyOfferId,
      );
      console.log(
        `surplus-proof: loaded ${history.sales.length} settled export sale(s) from ` +
          `${proofConfig.historyCsvPath} (${history.settledWithoutTx} without a Base tx, ` +
          `${history.skippedUnsettled} unsettled rows skipped)`,
      );
      historicalSales = async () => history.sales;
    }
    publisher = new SurplusVectorProofPublisher({
      ledger,
      earnings: () => client.getEarnings(),
      historicalSales,
      anchor: async (metadata) => {
        const built = await buildAnchorMetadataTx({ chain, walletKey, metadata });
        return { expectedTxHash: built.expectedTxHash };
      },
      awaitTx: (txHash, timeoutMs) => chain.awaitTx(txHash, timeoutMs),
      balanceLovelace: async () => {
        const utxos = await chain.queryUtxosByAddress(walletKey.address);
        return utxos.reduce((sum, utxo) => sum + utxo.lovelace, 0n);
      },
      reserveLovelace: proofConfig.reserveLovelace,
      feeBudgetLovelace: proofConfig.feeBudgetLovelace,
      settledStatuses: config.settledStatuses,
      intervalMs: proofConfig.intervalMs,
      confirmTimeoutMs: proofConfig.confirmTimeoutMs,
      log: (message) => console.log(message),
    });
    console.log(
      `surplus-proof: publisher enabled with wallet ${derived.address} and ledger ${proofConfig.ledgerPath}`,
    );
  }

  const dashboard = new SurplusDashboardService({
    controller,
    client,
    allowance,
    config,
    proofs,
  });
  const server = createSurplusServer(controller, dashboard);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(config.port, "0.0.0.0", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  await controller.start();
  publisher?.start();
  return { server, controller, publisher };
}

interface DashboardSource {
  getSnapshot(): Promise<SurplusDashboardSnapshot>;
}

export function createSurplusServer(
  controller: Pick<SurplusSellerController, "snapshot" | "healthy">,
  dashboard: DashboardSource,
): Server {
  return createServer((request, response) => {
    void handleRequest(controller, dashboard, request, response);
  });
}

async function handleRequest(
  controller: Pick<SurplusSellerController, "snapshot" | "healthy">,
  dashboard: DashboardSource,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = request.url?.split("?")[0] ?? "/";
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  const status = controller.snapshot();
  if (request.method === "GET" && path === "/healthz") {
    const healthy = controller.healthy();
    response.statusCode = healthy ? 200 : 503;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: healthy, phase: status.phase }));
    return;
  }
  if (request.method === "GET" && path === "/status") {
    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(status));
    return;
  }
  if (request.method === "GET" && path === "/internal/resale-dashboard") {
    try {
      const snapshot = await dashboard.getSnapshot();
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(snapshot));
    } catch {
      response.statusCode = 503;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "dashboard_data_unavailable" }));
    }
    return;
  }
  response.statusCode = 404;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ error: "not_found" }));
}

export async function main(
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const { server, controller, publisher } = await runSurplusSeller(env);
  console.log("Surplus seller controller listening");
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Surplus seller controller shutting down (${signal})`);
    await publisher?.stop();
    await controller.stop();
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    });
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

const invoked = fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "");
if (invoked) {
  main().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Surplus seller controller failed: ${detail}`);
    process.exitCode = 1;
  });
}
