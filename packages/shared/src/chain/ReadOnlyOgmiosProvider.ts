/**
 * ReadOnlyOgmiosProvider — Tier-2 ChainProvider.
 *
 * Implements tip(), queryUtxo(), queryUtxosByAddress(), and evaluateTx()
 * by issuing JSON-RPC requests to a real Ogmios server.
 *
 * submitTx() and awaitTx() throw NotSupportedError — this provider is
 * read-only and cannot mutate chain state.
 *
 * Every request is read-only. A transient error (HTTP status 500 or higher,
 * network error) is tried again, at most 2 more times: see ogmiosRetry.ts.
 *
 * JSON-RPC pattern follows apex-dashboard's ogmios-client.ts:
 *   - HTTP POST to ogmiosUrl
 *   - body: { jsonrpc: "2.0", method, params, id }
 *   - response: { jsonrpc: "2.0", result | error, id }
 */

import { WithheldOutputs, assertOutputFields } from "./datumGuard.js";
import type {
  ChainProvider,
  OutputReference,
  SlotNo,
  TxEvaluationResult,
  Utxo,
} from "./ChainProvider.js";
import { NotSupportedError } from "./ChainProvider.js";
import { fetchOgmiosRead } from "./ogmiosRetry.js";

export interface ReadOnlyOgmiosProviderOpts {
  ogmiosUrl: string;
  /** Request timeout in milliseconds. Defaults to 30 s. */
  timeoutMs?: number;
  /** Injected fetch for testing. Defaults to globalThis.fetch resolved at call time. */
  fetch?: typeof globalThis.fetch;
  /** Wait before a new try of a request, in ms. Injected for testing. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

interface OgmiosUtxo {
  transaction: { id: string };
  index: number;
  address: string;
  value: { ada?: { lovelace?: number | bigint }; [policy: string]: unknown };
  datumHash?: string | null;
  datum?: string | null;
  script?: unknown;
}

interface OgmiosBudget {
  memory?: number;
  cpu?: number;
  steps?: number;
}

interface OgmiosRedeemerEval {
  validator?: unknown;
  budget?: OgmiosBudget;
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

export class ReadOnlyOgmiosProvider implements ChainProvider {
  private readonly ogmiosUrl: string;
  private readonly timeoutMs: number;
  private readonly injectedFetch?: typeof globalThis.fetch;
  private readonly sleep?: (ms: number) => Promise<void>;
  private requestId = 0;

  constructor(opts: ReadOnlyOgmiosProviderOpts) {
    this.ogmiosUrl = opts.ogmiosUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.injectedFetch = opts.fetch;
    this.sleep = opts.sleep;
  }

  private resolveFetch(): typeof globalThis.fetch {
    return this.injectedFetch ?? globalThis.fetch;
  }

  // ── HTTP helper ──────────────────────────────────────────────────────

  private async rpc<TResult>(method: string, params?: unknown): Promise<TResult> {
    this.requestId += 1;
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      id: this.requestId,
    };
    if (params !== undefined) body.params = params;

    // A read-only request: a transient error is tried again (see ogmiosRetry.ts).
    const response = await fetchOgmiosRead({
      fetch: this.resolveFetch(),
      url: this.ogmiosUrl,
      method,
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
    });
    if (!response.ok) {
      throw new Error(`Ogmios HTTP error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as JsonRpcResponse<TResult>;
    if (json.error) {
      throw new Error(`Ogmios RPC error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    if (json.result === undefined) {
      throw new Error("Ogmios RPC response missing 'result'");
    }
    return json.result;
  }

  // ── ChainProvider interface ─────────────────────────────────────────

  async tip(): Promise<SlotNo> {
    const result = await this.rpc<{ slot?: number }>("queryNetwork/tip");
    return typeof result?.slot === "number" ? result.slot : 0;
  }

  async queryUtxo(ref: OutputReference): Promise<Utxo | null> {
    const params = {
      outputReferences: [{ transaction: { id: ref.txHash }, index: ref.index }],
    };
    const result = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", params);
    if (!Array.isArray(result) || result.length === 0) return null;
    return ogmiosAnswerToUtxos([result[0]])[0] ?? null;
  }

  async queryUtxosByAddress(address: string): Promise<Utxo[]> {
    const params = { addresses: [address] };
    const result = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", params);
    if (!Array.isArray(result)) return [];
    return ogmiosAnswerToUtxos(result);
  }

  async evaluateTx(txCborHex: string): Promise<TxEvaluationResult> {
    // We split error handling into two layers:
    //   - HTTP/transport errors (500, network failures): tried again (see
    //     ogmiosRetry.ts), then re-thrown so callers can distinguish "the
    //     node is down" from "the script failed".
    //   - JSON-RPC errors (Ogmios returned a structured error like script
    //     execution failure): returned as { ok: false, error }.
    const params = { transaction: { cbor: txCborHex } };

    this.requestId += 1;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      method: "evaluateTransaction",
      params,
      id: this.requestId,
    });
    const response = await fetchOgmiosRead({
      fetch: this.resolveFetch(),
      url: this.ogmiosUrl,
      method: "evaluateTransaction",
      body,
      timeoutMs: this.timeoutMs,
      sleep: this.sleep,
    });
    if (!response.ok) {
      throw new Error(`Ogmios HTTP error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as JsonRpcResponse<
      OgmiosRedeemerEval[] | OgmiosBudget
    >;
    if (json.error) {
      const message = json.error.message ?? "Ogmios evaluate error";
      const data = json.error.data !== undefined
        ? ` :: data=${JSON.stringify(json.error.data)}`
        : "";
      return {
        ok: false,
        error: `code=${json.error.code} ${message}${data}`,
      };
    }
    const cost = aggregateBudget(json.result);
    return cost ? { ok: true, cost } : { ok: true };
  }

  async submitTx(_txCborHex: string): Promise<string> {
    throw new NotSupportedError("submitTx");
  }

  async awaitTx(_txHash: string, _timeoutMs: number): Promise<void> {
    throw new NotSupportedError("awaitTx");
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * The UTxOs of one Ogmios answer. This client never leaves an output out: an output is absent from an answer only when the node does
 * not list it, and the callers read "absent" as "spent". An output whose datum fails the check stays in the list with no datum
 * (datumGuard.ts). The client maps no native script (only a Plutus V3 script, as opaque bytes), so the decoder library never reads
 * a script that comes from here. An output with a field that is longer than the ledger allows (assertOutputFields) fails the whole
 * call, as any other error of the node does. The log has one line for each output reference, one time.
 */
function ogmiosAnswerToUtxos(result: OgmiosUtxo[]): Utxo[] {
  const withheld = new WithheldOutputs();
  const utxos = result.map((o) => ogmiosUtxoToUtxo(o, withheld));
  withheld.report("ReadOnlyOgmiosProvider");
  return utxos;
}

function ogmiosUtxoToUtxo(o: OgmiosUtxo, withheld: WithheldOutputs): Utxo {
  assertOutputFields(o);
  const ref = `${o.transaction.id}#${o.index}`;
  const lovelaceRaw = o.value?.ada?.lovelace;
  const lovelace =
    typeof lovelaceRaw === "bigint"
      ? lovelaceRaw
      : typeof lovelaceRaw === "number"
        ? BigInt(Math.trunc(lovelaceRaw))
        : 0n;

  // Native assets: every key under value other than "ada" is a policy id, with
  // sub-keys for asset names. Flatten to a "policyId.assetName" → bigint map.
  const assets: Record<string, bigint> = {};
  for (const [policyId, assetMap] of Object.entries(o.value ?? {})) {
    if (policyId === "ada") continue;
    if (!assetMap || typeof assetMap !== "object") continue;
    for (const [assetName, qty] of Object.entries(assetMap)) {
      const unit = `${policyId}.${assetName}`;
      const amt =
        typeof qty === "bigint"
          ? qty
          : typeof qty === "number"
            ? BigInt(Math.trunc(qty))
            : 0n;
      assets[unit] = amt;
    }
  }

  const datumHex = typeof o.datum === "string" && o.datum.length > 0 ? withheld.datum(o.datum, ref, o.address) : null;
  // Only a Plutus V3 script maps here, and Plutus script bytes are opaque.
  const scriptRef = ogmiosScriptRef(o.script);

  return {
    ref: { txHash: o.transaction.id, index: o.index },
    address: o.address,
    lovelace,
    assets,
    datumHex,
    scriptRef,
  };
}

/**
 * Ogmios v6 returns a reference script as `{ language, cbor }`. `Utxo.scriptRef`
 * holds a Plutus V3 script (its compiled code, hex), so only `plutus:v3` maps;
 * another language gives null.
 */
function ogmiosScriptRef(script: unknown): string | null {
  if (typeof script !== "object" || script === null) return null;
  const { language, cbor } = script as { language?: unknown; cbor?: unknown };
  return language === "plutus:v3" && typeof cbor === "string" && cbor.length > 0 ? cbor : null;
}

function aggregateBudget(
  result: OgmiosRedeemerEval[] | OgmiosBudget | unknown,
): { memory: number; steps: number } | undefined {
  if (Array.isArray(result)) {
    let memory = 0;
    let steps = 0;
    for (const entry of result) {
      const b = entry?.budget;
      if (!b) continue;
      if (typeof b.memory === "number") memory += b.memory;
      if (typeof b.cpu === "number") steps += b.cpu;
      if (typeof b.steps === "number") steps += b.steps;
    }
    return { memory, steps };
  }
  if (result && typeof result === "object") {
    const b = result as OgmiosBudget;
    if (typeof b.memory === "number" || typeof b.steps === "number" || typeof b.cpu === "number") {
      return {
        memory: typeof b.memory === "number" ? b.memory : 0,
        steps:
          typeof b.steps === "number"
            ? b.steps
            : typeof b.cpu === "number"
              ? b.cpu
              : 0,
      };
    }
  }
  return undefined;
}
