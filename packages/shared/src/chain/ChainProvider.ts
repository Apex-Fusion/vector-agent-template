/**
 * ChainProvider — the single seam between off-chain code and the Cardano/Vector-L2 chain.
 *
 * Three implementations are planned (all arriving in M0-C, after Caroline's RED tests):
 *   - MockChainProvider        (Tier 1) — in-memory, synthetic slots, full submit/await
 *   - ReadOnlyOgmiosProvider   (Tier 2) — real Ogmios, eval + query only; submit/await throw NotSupportedError
 *   - LiveOgmiosProvider       (Tier 3) — real Ogmios, full submit + await on real chain
 *
 * Tests MUST depend on this interface (DI), never on a concrete implementation.
 * See docs/ARCHITECTURE.md section 7 for the test-architecture rationale.
 */

/** OutputReference — (txHash, index) pair uniquely identifying a UTxO on-chain. */
export type OutputReference = { txHash: string; index: number };

/** Slot number on the underlying chain (Cardano slot; Vector L2 inherits slot semantics). */
export type SlotNo = number;

/** Lovelace amount. ADA is 1e6 lovelace; AP3X uses its own decimals but is denominated here too. */
export type Lovelace = bigint;

/**
 * Utxo — a single unspent output as returned by the chain query layer.
 * `assets` key is the Cardano native-asset unit = policyId (hex) + assetName (hex); lovelace is separate.
 * `datumHex` is the inline datum encoded as hex CBOR; null when no inline datum present.
 * `scriptRef` is the inline script reference as hex; null when no reference script is attached.
 */
export interface Utxo {
  ref: OutputReference;
  address: string;
  lovelace: Lovelace;
  assets: Record<string, bigint>;
  datumHex: string | null;
  scriptRef: string | null;
}

/**
 * TxEvaluationResult — structured result of a dry-run evaluation.
 * `ok=true` ⇒ all scripts succeed and redeemer budget is within protocol limits.
 * `cost` is the aggregate execution-units budget (memory + CPU steps).
 * `error` carries a human-readable reason when `ok=false`.
 */
export interface TxEvaluationResult {
  ok: boolean;
  cost?: { memory: number; steps: number };
  error?: string;
}

/**
 * ChainProvider — contract for on-chain reads, tx evaluation, and submission.
 * Implementations MUST be concurrency-safe for concurrent reads. Writes (`submitTx`)
 * need not be thread-safe but MUST NOT double-submit on retry.
 */
export interface ChainProvider {
  /** Current chain tip slot. */
  tip(): Promise<SlotNo>;

  /** Fetch a single UTxO by reference; returns null if the output is spent or was never created. */
  queryUtxo(ref: OutputReference): Promise<Utxo | null>;

  /** All unspent UTxOs at an address. Returns [] for an address with no UTxOs. */
  queryUtxosByAddress(address: string): Promise<Utxo[]>;

  /**
   * Validate a CBOR-encoded transaction without broadcasting.
   * Available in all three tiers. MUST NOT mutate chain state.
   */
  evaluateTx(txCborHex: string): Promise<TxEvaluationResult>;

  /**
   * Broadcast a signed transaction. Returns the resulting txHash.
   * MockChainProvider simulates submission into its in-memory chain.
   * ReadOnlyOgmiosProvider MUST throw `NotSupportedError` (cannot mutate chain state).
   * LiveOgmiosProvider performs a real broadcast.
   */
  submitTx(txCborHex: string): Promise<string>;

  /**
   * Wait until a transaction with the given hash is observed on-chain.
   * Rejects with a timeout error after `timeoutMs`.
   * MockChainProvider resolves immediately if the tx is already in its known-tx set; otherwise rejects after timeout.
   * ReadOnlyOgmiosProvider MUST throw `NotSupportedError`.
   * LiveOgmiosProvider polls the real chain.
   */
  awaitTx(txHash: string, timeoutMs: number): Promise<void>;
}

/** Raised by ReadOnly / Mock providers when a caller invokes an operation that would mutate chain state. */
export class NotSupportedError extends Error {
  public readonly op: string;
  constructor(op: string) {
    super(`operation not supported in this provider: ${op}`);
    this.name = "NotSupportedError";
    this.op = op;
  }
}
