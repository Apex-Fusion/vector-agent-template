/**
 * MockChainProvider — Tier 1, in-memory implementation of ChainProvider.
 *
 * Implements the full ChainProvider interface plus test-only extensions
 * (advanceSlot, seed, buildTestTx). Intended to drive unit tests without
 * touching a real node or Ogmios.
 *
 * Semantics:
 *   - Synthetic slot counter (starts at 0, never auto-advances).
 *   - In-memory UTxO store keyed by "txHash#index".
 *   - submitTx returns sha256(txCborHex) as a 64-char lowercase hex string,
 *     idempotent on identical input, and attempts a best-effort JSON decode
 *     of the hex to recognise synthetic "spending" txs produced by tests.
 *   - awaitTx resolves immediately when the hash is already known; otherwise
 *     polls every ~10ms up to timeoutMs and then rejects with a timeout.
 */

// Namespace import — see blueprint.ts header.
import * as nodeCrypto from "crypto";
import type {
  ChainProvider,
  OutputReference,
  SlotNo,
  TxEvaluationResult,
  Utxo,
} from "./ChainProvider.js";

export interface MockChainProviderOpts {
  /** Custom evaluator. Default: always returns { ok: true }. */
  evaluator?: (txCborHex: string) => TxEvaluationResult;
}

/** Shape accepted by MockChainProvider.buildTestTx for synthetic spending txs. */
export interface TestTxShape {
  inputs: OutputReference[];
  outputs?: Utxo[];
}

function refKey(ref: OutputReference): string {
  return `${ref.txHash}#${ref.index}`;
}

function hexToString(hex: string): string | null {
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
  try {
    const buf = Buffer.from(hex, "hex");
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Extract the JSON portion of a length-prefixed test-tx hex.
 *
 * Test-tx format:
 *   first 8 hex chars (4 bytes) = big-endian uint32 JSON byte length
 *   next N bytes                = JSON UTF-8 payload
 *   trailing bytes              = free-form trailer (may include raw pkh bytes
 *                                 so tests can assert toContain(pkhHex))
 *
 * Returns the JSON string or null if the hex is not in this format.
 */
function extractTestTxJson(hex: string): string | null {
  if (hex.length < 8) return null;
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null;

  const lenHex = hex.slice(0, 8);
  const jsonLen = parseInt(lenHex, 16);
  if (!Number.isFinite(jsonLen) || jsonLen <= 0) return null;

  const jsonHexLen = jsonLen * 2;
  if (8 + jsonHexLen > hex.length) return null;

  const jsonHex = hex.slice(8, 8 + jsonHexLen);
  try {
    const buf = Buffer.from(jsonHex, "hex");
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export class MockChainProvider implements ChainProvider {
  private readonly evaluator: (txCborHex: string) => TxEvaluationResult;
  private currentSlot: SlotNo;
  private readonly utxos: Map<string, Utxo>;
  private readonly knownTxs: Map<string, string>;

  constructor(opts?: MockChainProviderOpts) {
    this.evaluator = opts?.evaluator ?? (() => ({ ok: true }));
    this.currentSlot = 0;
    this.utxos = new Map();
    this.knownTxs = new Map();
  }

  // ── ChainProvider interface ─────────────────────────────────────────

  async tip(): Promise<SlotNo> {
    return this.currentSlot;
  }

  async queryUtxo(ref: OutputReference): Promise<Utxo | null> {
    return this.utxos.get(refKey(ref)) ?? null;
  }

  async queryUtxosByAddress(address: string): Promise<Utxo[]> {
    const out: Utxo[] = [];
    for (const u of this.utxos.values()) {
      if (u.address === address) out.push(u);
    }
    return out;
  }

  async evaluateTx(txCborHex: string): Promise<TxEvaluationResult> {
    return this.evaluator(txCborHex);
  }

  async submitTx(txCborHex: string): Promise<string> {
    const hash = nodeCrypto.createHash("sha256")
      .update(txCborHex, "utf8")
      .digest("hex")
      .toLowerCase();

    if (!this.knownTxs.has(hash)) {
      this.knownTxs.set(hash, txCborHex);
      this.applySpendingSideEffects(txCborHex, hash);
    }

    return hash;
  }

  async awaitTx(txHash: string, timeoutMs: number): Promise<void> {
    if (this.knownTxs.has(txHash)) return;

    const pollInterval = 10;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const wait = Math.min(pollInterval, Math.max(0, remaining));
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      if (this.knownTxs.has(txHash)) return;
    }

    throw new Error(
      `awaitTx timeout after ${timeoutMs}ms waiting for txHash ${txHash}`,
    );
  }

  // ── Test-only extensions (NOT part of ChainProvider) ────────────────

  /** Advance synthetic tip by n slots. n MUST be a non-negative integer. */
  advanceSlot(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`advanceSlot: n must be a non-negative integer, got ${n}`);
    }
    this.currentSlot += n;
  }

  /** Plant a UTxO in the in-memory store. Overwrites an existing entry with the same ref. */
  seed(utxo: Utxo): void {
    this.utxos.set(refKey(utxo.ref), utxo);
  }

  /**
   * Build a synthetic tx CBOR hex that MockChainProvider recognises as a
   * spending tx. The hex is hex(JSON.stringify({ inputs, outputs? })).
   */
  static buildTestTx(shape: TestTxShape): string {
    return Buffer.from(JSON.stringify(shape), "utf8").toString("hex");
  }

  // ── Internals ───────────────────────────────────────────────────────

  /**
   * Best-effort decode of the tx CBOR hex as a JSON test-tx. If parsing
   * succeeds, any matching UTxOs in `inputs` are removed from the store and
   * any UTxOs in `outputs` are seeded. Anything else is ignored.
   *
   * The `outputs` extension is used by M1-B tx builders so that calling
   * `submitTx` simulates the on-chain effect of producing continuing or
   * terminal outputs (extending the existing `inputs`-only convention).
   *
   * Outputs may use the placeholder string "$self" for ref.txHash to mean
   * "the hash of this tx itself" — resolved by the caller-supplied `selfHash`
   * arg. This sidesteps the circular dependency between sha256(txCborHex) and
   * outputs that need to reference their own tx hash.
   *
   * BigInt support: lovelace fields may arrive as strings (JSON has no bigint)
   * with a "n" suffix or as plain numbers; we accept both.
   */
  private applySpendingSideEffects(txCborHex: string, selfHash: string): void {
    // Try the M1-B length-prefixed format first; fall back to the legacy M0
    // bare-JSON format used by mock-chain-provider tests.
    const asText = extractTestTxJson(txCborHex) ?? hexToString(txCborHex);
    if (asText === null) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(asText, (_key, value) => {
        if (typeof value === "string" && /^-?\d+n$/.test(value)) {
          return BigInt(value.slice(0, -1));
        }
        return value;
      });
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const maybeInputs = (parsed as { inputs?: unknown }).inputs;
    if (Array.isArray(maybeInputs)) {
      for (const input of maybeInputs) {
        if (!input || typeof input !== "object") continue;
        const rec = input as { txHash?: unknown; index?: unknown };
        if (typeof rec.txHash !== "string") continue;
        if (typeof rec.index !== "number") continue;
        this.utxos.delete(refKey({ txHash: rec.txHash, index: rec.index }));
      }
    }

    const maybeOutputs = (parsed as { outputs?: unknown }).outputs;
    if (Array.isArray(maybeOutputs)) {
      for (const output of maybeOutputs) {
        if (!output || typeof output !== "object") continue;
        const rec = output as Partial<Utxo>;
        if (!rec.ref || typeof rec.ref !== "object") continue;
        const ref = rec.ref as { txHash?: unknown; index?: unknown };
        if (typeof ref.txHash !== "string") continue;
        if (typeof ref.index !== "number") continue;
        if (typeof rec.address !== "string") continue;

        const resolvedTxHash = ref.txHash === "$self" ? selfHash : ref.txHash;

        const utxo: Utxo = {
          ref: { txHash: resolvedTxHash, index: ref.index },
          address: rec.address,
          lovelace:
            typeof rec.lovelace === "bigint"
              ? rec.lovelace
              : typeof rec.lovelace === "number"
                ? BigInt(rec.lovelace)
                : 0n,
          assets: (rec.assets ?? {}) as Record<string, bigint>,
          datumHex: typeof rec.datumHex === "string" ? rec.datumHex : null,
          scriptRef: typeof rec.scriptRef === "string" ? rec.scriptRef : null,
        };
        this.utxos.set(refKey(utxo.ref), utxo);
      }
    }
  }
}
