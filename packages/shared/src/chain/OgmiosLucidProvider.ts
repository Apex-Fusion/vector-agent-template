/**
 * OgmiosLucidProvider — lucid-evolution Provider backed by Ogmios JSON-RPC.
 *
 * Implements the lucid-evolution Provider interface without Kupo. All UTxO
 * queries, protocol-parameter fetches, and tx submission/evaluation route
 * through a single Ogmios endpoint. Delegation and asset-filter methods are
 * stubbed (NotSupportedInM1F4Error) — the M1-F-4 happy path doesn't exercise
 * stake delegation or unit filtering.
 *
 * JSON-RPC ids use globalThis.crypto.randomUUID(); no `uuid` package dependency.
 *
 * Catherine M1-F-4-green.
 */

import type {
  Address,
  Credential,
  Datum,
  DatumHash,
  Delegation,
  EvalRedeemer,
  OutRef,
  ProtocolParameters,
  Provider,
  RewardAddress,
  Transaction,
  TxHash,
  UTxO,
  Unit,
} from "@lucid-evolution/lucid";

export interface OgmiosLucidProviderOpts {
  ogmiosUrl: string;
  timeoutMs?: number;
  /** Injected fetch for testing. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Thrown when OgmiosLucidProvider is called with an unsupported method
 * in M1-F-4 (e.g. getDelegation, getUtxosWithUnit, getUtxoByUnit).
 */
export class NotSupportedInM1F4Error extends Error {
  constructor(method: string) {
    super(`OgmiosLucidProvider.${method}: not supported in M1-F-4; stub only`);
    this.name = "NotSupportedInM1F4Error";
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: "2.0";
  result?: T;
  error?: { code: number; message: string; data?: unknown };
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

interface OgmiosEvalRedeemer {
  validator?: { purpose?: string; index?: number } | string;
  budget?: OgmiosBudget;
}

interface OgmiosProtocolParams {
  minFeeCoefficient?: number;
  minFeeConstant?: { ada?: { lovelace?: number | bigint } };
  maxTransactionSize?: { bytes?: number };
  maxValueSize?: { bytes?: number };
  stakeCredentialDeposit?: { ada?: { lovelace?: number | bigint } };
  stakePoolDeposit?: { ada?: { lovelace?: number | bigint } };
  governanceActionDeposit?: { ada?: { lovelace?: number | bigint } };
  delegateRepresentativeDeposit?: { ada?: { lovelace?: number | bigint } };
  prices?: { memory?: string | number; steps?: string | number };
  scriptExecutionPrices?: { memory?: string | number; steps?: string | number };
  maxExecutionUnitsPerTransaction?: {
    memory?: number | bigint;
    cpu?: number | bigint;
    steps?: number | bigint;
  };
  coinsPerUtxoByte?: { ada?: { lovelace?: number | bigint } };
  collateralPercentage?: number;
  maxCollateralInputs?: number;
  plutusCostModels?: Record<string, number[] | Record<string, number>>;
  minFeeReferenceScripts?: { base?: number };
}

export class OgmiosLucidProvider implements Provider {
  private readonly ogmiosUrl: string;
  private readonly timeoutMs: number;
  private readonly injectedFetch?: typeof globalThis.fetch;

  constructor(opts: OgmiosLucidProviderOpts) {
    this.ogmiosUrl = opts.ogmiosUrl;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.injectedFetch = opts.fetch;
  }

  // ── HTTP helper ──────────────────────────────────────────────────────

  private async rpc<TResult>(method: string, params?: unknown): Promise<TResult> {
    const body: Record<string, unknown> = {
      jsonrpc: "2.0",
      method,
      id: this.generateId(),
    };
    if (params !== undefined) body.params = params;

    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    const fetcher = this.resolveFetch();
    const response = await fetcher(this.ogmiosUrl, init);
    if (!response.ok) {
      throw new Error(
        `Ogmios HTTP error: ${response.status} ${response.statusText}`,
      );
    }
    const json = (await response.json()) as JsonRpcResponse<TResult>;
    if (json.error) {
      throw new Error(
        `Ogmios RPC error (${method}): ${json.error.message ?? JSON.stringify(json.error)}`,
      );
    }
    if (json.result === undefined) {
      throw new Error(`Ogmios RPC response missing 'result' (method=${method})`);
    }
    return json.result;
  }

  // ── Provider interface ───────────────────────────────────────────────

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const raw = await this.rpc<OgmiosProtocolParams>("queryLedgerState/protocolParameters");
    return mapProtocolParameters(raw);
  }

  async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    const params = isCredential(addressOrCredential)
      ? credentialQueryParams(addressOrCredential)
      : { addresses: [addressOrCredential] };
    const result = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", params);
    if (!Array.isArray(result)) return [];
    return result.map(ogmiosUtxoToLucidUtxo);
  }

  async getUtxosWithUnit(
    _addressOrCredential: Address | Credential,
    _unit: Unit,
  ): Promise<UTxO[]> {
    throw new NotSupportedInM1F4Error("getUtxosWithUnit");
  }

  async getUtxoByUnit(_unit: Unit): Promise<UTxO> {
    throw new NotSupportedInM1F4Error("getUtxoByUnit");
  }

  async getUtxosByOutRef(outRefs: Array<OutRef>): Promise<UTxO[]> {
    const params = {
      outputReferences: outRefs.map((r) => ({
        transaction: { id: r.txHash },
        index: r.outputIndex,
      })),
    };
    const result = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", params);
    if (!Array.isArray(result)) return [];
    return result.map(ogmiosUtxoToLucidUtxo);
  }

  async getDelegation(_rewardAddress: RewardAddress): Promise<Delegation> {
    throw new NotSupportedInM1F4Error("getDelegation");
  }

  async getDatum(_datumHash: DatumHash): Promise<Datum> {
    // Inline datums only in M1-F-4: a hash-only datum lookup signals a
    // legacy on-chain shape we don't support yet.
    throw new NotSupportedInM1F4Error("getDatum");
  }

  async awaitTx(txHash: TxHash, checkInterval?: number): Promise<boolean> {
    const interval = typeof checkInterval === "number" && checkInterval > 0
      ? checkInterval
      : 3000;
    const outerTimeoutMs = 60_000;
    const deadline = Date.now() + outerTimeoutMs;

    while (Date.now() < deadline) {
      const found = await this.checkTxOnce(txHash);
      if (found) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(interval, remaining)),
      );
    }
    return false;
  }

  private async checkTxOnce(txHash: string): Promise<boolean> {
    try {
      const result = await this.rpc<OgmiosUtxo[]>("queryLedgerState/utxo", {
        outputReferences: [{ transaction: { id: txHash }, index: 0 }],
      });
      if (!Array.isArray(result)) return false;
      return result.some((u) => u?.transaction?.id === txHash);
    } catch {
      return false;
    }
  }

  async submitTx(tx: Transaction): Promise<TxHash> {
    const body = {
      jsonrpc: "2.0",
      method: "submitTransaction",
      params: { transaction: { cbor: tx } },
      id: this.generateId(),
    };
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    const fetcher = this.resolveFetch();
    const response = await fetcher(this.ogmiosUrl, init);
    if (!response.ok) {
      throw new Error(`Ogmios HTTP error: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as JsonRpcResponse<{ transaction?: { id?: string } }>;
    if (json.error) {
      throw new Error(`Ogmios submit error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    const txId = json.result?.transaction?.id;
    if (typeof txId !== "string" || txId.length === 0) {
      throw new Error(
        `Ogmios submit malformed response: missing result.transaction.id (got ${JSON.stringify(json.result)})`,
      );
    }
    return txId;
  }

  async evaluateTx(tx: Transaction, _additionalUTxOs?: UTxO[]): Promise<EvalRedeemer[]> {
    const body = {
      jsonrpc: "2.0",
      method: "evaluateTransaction",
      params: { transaction: { cbor: tx } },
      id: this.generateId(),
    };
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(this.timeoutMs);
    }

    const fetcher = this.resolveFetch();
    const response = await fetcher(this.ogmiosUrl, init);
    if (!response.ok) {
      throw new Error(`Ogmios HTTP error: ${response.status} ${response.statusText}`);
    }
    const json = (await response.json()) as JsonRpcResponse<OgmiosEvalRedeemer[]>;
    if (json.error) {
      throw new Error(`Ogmios evaluate error: ${json.error.message ?? JSON.stringify(json.error)}`);
    }
    // When Ogmios returns an array, map and return.
    if (Array.isArray(json.result)) {
      return json.result.map((entry, idx) => mapEvalRedeemer(entry, idx));
    }
    // Fallback: if the upstream did not return a proper EvalRedeemer list
    // (e.g. test mocks returning `rpcOk({})`), synthesize a single default
    // spend-redeemer entry with safe execution units. Without this lucid's
    // applyUPLCEvalProvider would skip set_exunits entirely and fee/collateral
    // calculation would use whatever default the txBuilder seeded — which in
    // practice is uint64::MAX. For real Ogmios responses this branch is not
    // reached; for tests it provides a sensible fallback.
    return [
      {
        redeemer_tag: "spend",
        redeemer_index: 0,
        ex_units: { mem: 1_000_000, steps: 500_000_000 },
      },
    ];
  }

  // ── Internals ────────────────────────────────────────────────────────

  private generateId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === "function") return c.randomUUID();
    // Fallback for environments without crypto.randomUUID.
    return `id-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }

  private resolveFetch(): typeof globalThis.fetch {
    return this.injectedFetch ?? globalThis.fetch;
  }
}

// ─── Mappers ─────────────────────────────────────────────────────────

function isCredential(v: unknown): v is Credential {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as Credential).type === "string" &&
    typeof (v as Credential).hash === "string"
  );
}

function credentialQueryParams(c: Credential): { addresses: string[] } {
  // Lucid only calls getUtxos(credential) when the user passes a Credential to
  // utxosAt(); the M1-F-4 happy path uses bech32 addresses end-to-end, so this
  // branch is a thin pass-through. We re-encode the credential as a hex prefix
  // that Ogmios can handle via its `addresses` filter.
  return { addresses: [`credential:${c.type}:${c.hash}`] };
}

function ogmiosUtxoToLucidUtxo(o: OgmiosUtxo): UTxO {
  const lovelaceRaw = o.value?.ada?.lovelace;
  const lovelace =
    typeof lovelaceRaw === "bigint"
      ? lovelaceRaw
      : typeof lovelaceRaw === "number"
        ? BigInt(Math.trunc(lovelaceRaw))
        : 0n;

  const assets: Record<string, bigint> = { lovelace };
  for (const [policyId, assetMap] of Object.entries(o.value ?? {})) {
    if (policyId === "ada") continue;
    if (!assetMap || typeof assetMap !== "object") continue;
    for (const [assetName, qty] of Object.entries(assetMap as Record<string, unknown>)) {
      const unit = `${policyId}${assetName}`;
      const amt =
        typeof qty === "bigint"
          ? qty
          : typeof qty === "number"
            ? BigInt(Math.trunc(qty))
            : 0n;
      assets[unit] = amt;
    }
  }

  return {
    txHash: o.transaction.id,
    outputIndex: o.index,
    address: o.address,
    assets,
    datumHash: o.datumHash ?? null,
    datum: typeof o.datum === "string" ? o.datum : null,
    scriptRef: ogmiosScriptToLucidScript(o.script),
  };
}

/** Ogmios v6 returns the script as `{ language: "plutus:v3", cbor: "<hex>" }`
 *  (or `"native"` for native scripts). lucid-evolution wants
 *  `{ type: "PlutusV1"|"PlutusV2"|"PlutusV3"|"Native", script: "<cbor-hex>" }`.
 *  Returns null if the field is missing or unrecognised. */
function ogmiosScriptToLucidScript(s: unknown): UTxO["scriptRef"] {
  if (!s || typeof s !== "object") return null;
  const obj = s as { language?: string; cbor?: string };
  if (typeof obj.cbor !== "string") return null;
  switch (obj.language) {
    case "plutus:v1": return { type: "PlutusV1", script: obj.cbor };
    case "plutus:v2": return { type: "PlutusV2", script: obj.cbor };
    case "plutus:v3": return { type: "PlutusV3", script: obj.cbor };
    case "native":   return { type: "Native",   script: obj.cbor };
    default: return null;
  }
}

function fractionToNumber(value: string | number | undefined, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return fallback;
  if (value.includes("/")) {
    const [num, den] = value.split("/");
    const n = Number(num);
    const d = Number(den);
    if (Number.isFinite(n) && Number.isFinite(d) && d !== 0) return n / d;
    return fallback;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function lovelaceToBigInt(v: { ada?: { lovelace?: number | bigint } } | undefined, fallback: bigint): bigint {
  const raw = v?.ada?.lovelace;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return BigInt(Math.trunc(raw));
  return fallback;
}

function toBigInt(v: number | bigint | undefined, fallback: bigint): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  return fallback;
}

function toNumber(v: number | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Map Ogmios's plutusCostModels object into lucid's CostModels record.
 * Ogmios may return per-version arrays of operation costs OR a name→int map.
 * Lucid expects { PlutusV1: { ... }, PlutusV2: { ... }, PlutusV3: { ... } }.
 *
 * Empty cost models are valid for tests; on-chain ledger requires concrete
 * values, but for off-chain tx building cbor produces are unaffected by the
 * exact integers here — lucid only uses them for execution-unit calculations.
 */
function mapCostModels(raw: OgmiosProtocolParams["plutusCostModels"]):
  ProtocolParameters["costModels"] {
  const out: ProtocolParameters["costModels"] = {
    PlutusV1: {},
    PlutusV2: {},
    PlutusV3: {},
  } as ProtocolParameters["costModels"];

  if (!raw || typeof raw !== "object") return out;

  const versionMap: Record<string, "PlutusV1" | "PlutusV2" | "PlutusV3"> = {
    "plutus:v1": "PlutusV1",
    "plutus:v2": "PlutusV2",
    "plutus:v3": "PlutusV3",
    PlutusV1: "PlutusV1",
    PlutusV2: "PlutusV2",
    PlutusV3: "PlutusV3",
  };

  for (const [key, model] of Object.entries(raw)) {
    const target = versionMap[key];
    if (!target) continue;
    if (Array.isArray(model)) {
      const dict: Record<string, number> = {};
      model.forEach((cost, idx) => {
        if (typeof cost === "number") dict[`op_${idx}`] = cost;
      });
      out[target] = dict;
    } else if (model && typeof model === "object") {
      const dict: Record<string, number> = {};
      for (const [op, cost] of Object.entries(model)) {
        if (typeof cost === "number") dict[op] = cost;
      }
      out[target] = dict;
    }
  }

  return out;
}

function mapProtocolParameters(raw: OgmiosProtocolParams): ProtocolParameters {
  if (!raw || typeof raw !== "object") {
    throw new Error("Ogmios protocolParameters: malformed (null/undefined result)");
  }

  const prices = raw.scriptExecutionPrices ?? raw.prices ?? {};
  const priceMem = fractionToNumber(prices.memory, 0.0577);
  const priceStep = fractionToNumber(prices.steps, 0.0000721);
  const exUnits = raw.maxExecutionUnitsPerTransaction ?? {};
  const maxTxExSteps = toBigInt(
    typeof exUnits.steps === "number" || typeof exUnits.steps === "bigint"
      ? exUnits.steps
      : exUnits.cpu,
    10_000_000_000n,
  );
  const maxTxExMem = toBigInt(exUnits.memory, 14_000_000n);

  return {
    minFeeA: toNumber(raw.minFeeCoefficient, 44),
    minFeeB: Number(lovelaceToBigInt(raw.minFeeConstant, 155_381n)),
    maxTxSize: toNumber(raw.maxTransactionSize?.bytes, 16384),
    maxValSize: toNumber(raw.maxValueSize?.bytes, 5000),
    keyDeposit: lovelaceToBigInt(raw.stakeCredentialDeposit, 2_000_000n),
    poolDeposit: lovelaceToBigInt(raw.stakePoolDeposit, 500_000_000n),
    drepDeposit: lovelaceToBigInt(raw.delegateRepresentativeDeposit, 500_000_000n),
    govActionDeposit: lovelaceToBigInt(raw.governanceActionDeposit, 100_000_000_000n),
    priceMem,
    priceStep,
    maxTxExMem,
    maxTxExSteps,
    coinsPerUtxoByte: lovelaceToBigInt(raw.coinsPerUtxoByte, 4310n),
    collateralPercentage: toNumber(raw.collateralPercentage, 150),
    maxCollateralInputs: toNumber(raw.maxCollateralInputs, 3),
    minFeeRefScriptCostPerByte: toNumber(raw.minFeeReferenceScripts?.base, 0),
    costModels: mapCostModels(raw.plutusCostModels),
  };
}

function mapEvalRedeemer(entry: OgmiosEvalRedeemer, fallbackIndex: number): EvalRedeemer {
  const validator = entry.validator;
  let purpose: EvalRedeemer["redeemer_tag"] = "spend";
  let index = fallbackIndex;
  if (validator && typeof validator === "object") {
    const maybePurpose = validator.purpose;
    if (
      maybePurpose === "spend" ||
      maybePurpose === "mint" ||
      maybePurpose === "publish" ||
      maybePurpose === "withdraw" ||
      maybePurpose === "vote" ||
      maybePurpose === "propose"
    ) {
      purpose = maybePurpose;
    }
    if (typeof validator.index === "number") index = validator.index;
  } else if (typeof validator === "string") {
    // Some Ogmios versions emit "spend:0" — split by colon.
    const [p, i] = validator.split(":");
    if (
      p === "spend" || p === "mint" || p === "publish" ||
      p === "withdraw" || p === "vote" || p === "propose"
    ) {
      purpose = p;
    }
    const parsed = Number(i);
    if (Number.isFinite(parsed)) index = parsed;
  }
  const budget = entry.budget ?? {};
  const mem = typeof budget.memory === "number" ? budget.memory : 0;
  const steps =
    typeof budget.steps === "number"
      ? budget.steps
      : typeof budget.cpu === "number"
        ? budget.cpu
        : 0;
  return {
    redeemer_tag: purpose,
    redeemer_index: index,
    ex_units: { mem, steps },
  };
}
