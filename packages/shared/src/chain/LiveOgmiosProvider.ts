/**
 * LiveOgmiosProvider — Tier-3 ChainProvider.
 *
 * Implements the full ChainProvider interface against a real Ogmios server:
 *   - tip(), queryUtxo(), queryUtxosByAddress(), evaluateTx() — identical to
 *     ReadOnlyOgmiosProvider; implemented via composition (holds an inner
 *     ReadOnlyOgmiosProvider and forwards all read calls).
 *   - submitTx(txCborHex) — HTTP POST JSON-RPC `submitTransaction` to ogmiosUrl.
 *     Returns the resulting txHash string from `result.transaction.id`.
 *     On Ogmios JSON-RPC error, throws OgmiosSubmitError (structured: name,
 *     code, data fields preserved for upstream retry / dispute flows).
 *   - awaitTx(txHash, timeoutMs) — polls `queryLedgerState/utxo` every
 *     pollIntervalMs (default 2000 ms) using a synthetic OutputReference
 *     {transaction:{id:txHash}, index:0} and resolves when ANY returned UTxO
 *     has `transaction.id === txHash` (index-agnostic). Rejects after
 *     timeoutMs via AbortController (the in-flight fetch is aborted too).
 *
 * JSON-RPC id: submitTx uses globalThis.crypto.randomUUID() (Node 19+ /
 * modern browser). Tests assert UUID v4 format on the request id field.
 */

import type {
  ChainProvider,
  OutputReference,
  SlotNo,
  TxEvaluationResult,
  Utxo,
} from "./ChainProvider.js";
import { ReadOnlyOgmiosProvider } from "./ReadOnlyOgmiosProvider.js";

export interface LiveOgmiosProviderOpts {
  ogmiosUrl: string;
  /** Request timeout in milliseconds for read calls and submitTx. Defaults to 30 s. */
  timeoutMs?: number;
  /** Polling interval in milliseconds for awaitTx. Defaults to 2000 ms. */
  pollIntervalMs?: number;
  /** Injected fetch for testing. Defaults to globalThis.fetch resolved at call time. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thrown by LiveOgmiosProvider.submitTx when Ogmios returns a JSON-RPC error.
 *
 * `code`  — JSON-RPC error code from the Ogmios response.
 * `data`  — JSON-RPC error data field (may be undefined).
 */
export class OgmiosSubmitError extends Error {
  public readonly code: number;
  public readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "OgmiosSubmitError";
    this.code = code;
    this.data = data;
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface OgmiosUtxoMin {
  transaction?: { id?: string };
  index?: number;
}

interface OgmiosSubmitResult {
  transaction?: { id?: string };
}

export class LiveOgmiosProvider implements ChainProvider {
  private readonly read: ReadOnlyOgmiosProvider;
  private readonly ogmiosUrl: string;
  private readonly timeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly injectedFetch?: typeof globalThis.fetch;

  constructor(opts: LiveOgmiosProviderOpts) {
    // Forward read methods to a private ReadOnlyOgmiosProvider so request
    // bodies are byte-identical to the read-only path (composition parity).
    this.read = new ReadOnlyOgmiosProvider({
      ogmiosUrl: opts.ogmiosUrl,
      timeoutMs: opts.timeoutMs,
      fetch: opts.fetch,
    });
    this.ogmiosUrl = opts.ogmiosUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.injectedFetch = opts.fetch;
  }

  /** Expose the underlying Ogmios URL so live tx builders can construct an
   * OgmiosLucidProvider against the same endpoint. */
  public get url(): string {
    return this.ogmiosUrl;
  }

  /** Expose the injected fetch so live tx builders can route lucid traffic
   * through the same test mock the chain provider uses. */
  public get fetchImpl(): typeof globalThis.fetch | undefined {
    return this.injectedFetch;
  }

  // ── Read methods — forward to inner ReadOnlyOgmiosProvider ──────────

  tip(): Promise<SlotNo> {
    return this.read.tip();
  }

  queryUtxo(ref: OutputReference): Promise<Utxo | null> {
    return this.read.queryUtxo(ref);
  }

  queryUtxosByAddress(address: string): Promise<Utxo[]> {
    return this.read.queryUtxosByAddress(address);
  }

  evaluateTx(txCborHex: string): Promise<TxEvaluationResult> {
    return this.read.evaluateTx(txCborHex);
  }

  // ── submitTx ──────────────────────────────────────────────────────

  async submitTx(txCborHex: string): Promise<string> {
    const id = generateUuid();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "submitTransaction",
      params: { transaction: { cbor: txCborHex } },
      id,
    });

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    const fetcher = this.resolveFetch();
    const response = await fetcher(this.ogmiosUrl, init);
    if (!response.ok) {
      let bodyText = "";
      try { bodyText = await response.text(); } catch { /* noop */ }
      throw new Error(
        `Ogmios HTTP error: ${response.status} ${response.statusText} :: ${bodyText.slice(0, 1500)}`,
      );
    }

    const json = (await response.json()) as JsonRpcResponse<OgmiosSubmitResult>;
    if (json.error) {
      throw new OgmiosSubmitError(
        json.error.message ?? "Ogmios submit error",
        json.error.code,
        json.error.data,
      );
    }
    const txId = json.result?.transaction?.id;
    if (typeof txId !== "string" || txId.length === 0) {
      throw new Error(
        `submit_malformed_response: Ogmios did not return result.transaction.id (got ${JSON.stringify(json.result)})`,
      );
    }
    return txId;
  }

  // ── awaitTx ───────────────────────────────────────────────────────

  async awaitTx(txHash: string, timeoutMs: number): Promise<void> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const deadline = Date.now() + timeoutMs;

    try {
      // First poll runs immediately (no leading sleep): if the tx is already
      // confirmed, the call returns after a single fetch.
      while (true) {
        if (controller.signal.aborted) {
          throw new Error(`awaitTx_timeout: tx ${txHash} not observed within ${timeoutMs}ms`);
        }

        const found = await this.checkOnce(txHash, controller.signal);
        if (found) return;

        if (Date.now() >= deadline || controller.signal.aborted) {
          throw new Error(`awaitTx_timeout: tx ${txHash} not observed within ${timeoutMs}ms`);
        }

        // Sleep poll-interval, but interruptible by the abort signal.
        await sleepInterruptible(this.pollIntervalMs, controller.signal, txHash, timeoutMs);
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async checkOnce(txHash: string, signal: AbortSignal): Promise<boolean> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "queryLedgerState/utxo",
      params: {
        outputReferences: [{ transaction: { id: txHash }, index: 0 }],
      },
      // awaitTx polls don't need a UUID — a numeric counter would suffice,
      // but we use a UUID for consistency with submitTx / debuggability.
      id: generateUuid(),
    });

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal,
    };

    const fetcher = this.resolveFetch();
    // Race the fetch against the abort signal. Real `fetch` rejects when its
    // signal aborts, but test mocks may not honour signals — so we add an
    // explicit abort race so the await terminates promptly when the timeout
    // controller fires.
    const fetchPromise = fetcher(this.ogmiosUrl, init);
    const response = await Promise.race([fetchPromise, abortRace(signal)]);
    if (!response.ok) {
      // Network blip during polling — fall through to the next poll rather
      // than aborting the whole await. Only the timeout signal terminates.
      return false;
    }

    const json = (await response.json()) as JsonRpcResponse<OgmiosUtxoMin[]>;
    if (json.error || !Array.isArray(json.result)) return false;

    // Index-agnostic: if any UTxO with this txHash is returned, the tx is on
    // chain. Ogmios can return a UTxO at index > 0 even when we asked at 0.
    return json.result.some((u) => u?.transaction?.id === txHash);
  }

  private resolveFetch(): typeof globalThis.fetch {
    // Resolve at call time so test reassignments of globalThis.fetch take
    // effect even when the provider was constructed before the reassignment.
    return this.injectedFetch ?? globalThis.fetch;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateUuid(): string {
  // globalThis.crypto.randomUUID is available in Node 19+ and modern browsers.
  // Vitest under Node 20 exposes it. We do not depend on the `uuid` package.
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  // Fallback — should not be reached in supported runtimes. Generates a
  // pseudo-UUIDv4-shaped string from Math.random; only used if crypto is
  // unavailable (e.g. very old Node). Tests run on Node 20+ where the
  // primary path is taken.
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, "0");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
}

/**
 * Returns a Promise that rejects when the given AbortSignal aborts. Used to
 * race against a fetch promise so awaitTx can terminate promptly even when
 * the underlying fetch implementation does not honour its signal (e.g. test
 * mocks that return a never-resolving promise).
 */
function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("awaitTx_timeout: aborted"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error("awaitTx_timeout: aborted")),
      { once: true },
    );
  });
}

function sleepInterruptible(
  ms: number,
  signal: AbortSignal,
  txHash: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(`awaitTx_timeout: tx ${txHash} not observed within ${timeoutMs}ms`));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error(`awaitTx_timeout: tx ${txHash} not observed within ${timeoutMs}ms`));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
