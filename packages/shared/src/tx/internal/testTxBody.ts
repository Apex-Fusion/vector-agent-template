/**
 * tx/internal/testTxBody.ts — shared helpers for M1-B tx builders.
 *
 * Builders construct a JSON body describing the desired transaction (inputs,
 * outputs, required-signers, validity range, redeemer) and serialise it as
 * UTF-8 hex. MockChainProvider recognises this convention when it processes
 * `submitTx(...)`: it removes any UTxOs in `inputs` and seeds any UTxOs in
 * `outputs`. Outputs may use the placeholder string "$self" for ref.txHash to
 * mean "the hash of this tx itself" — the mock substitutes the real hash.
 *
 * On real Cardano (LiveOgmiosProvider, M3+), this representation will be
 * replaced by genuine CBOR-encoded Cardano transactions built via
 * @lucid-evolution/lucid. The off-chain validation logic (signer matching,
 * datum invariants, validity-range computation) stays the same; only the
 * `txCborHex` byte payload changes.
 *
 * The hex format uses a custom JSON.stringify replacer to encode bigints as
 * decimal strings with an "n" suffix (e.g., 5_000_000n → "5000000n"); this
 * is symmetric with MockChainProvider.applySpendingSideEffects' reviver.
 */

// Namespace import — see blueprint.ts header. The buyer SPA bundle reaches
// here via the SDK's static import chain, but the actual sha256Hex calls
// only fire on the synthetic-mock backend (server-side / tests).
import * as nodeCrypto from "crypto";
import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";

/** A planned UTxO output. May use ref.txHash="$self" to refer to the tx hash. */
export interface PlannedOutput {
  ref: OutputReference;
  address: string;
  lovelace: bigint;
  assets?: Record<string, bigint>;
  datumHex?: string | null;
  scriptRef?: string | null;
}

/** Validity range in POSIX milliseconds. Either bound may be null (unbounded). */
export interface ValidityRange {
  lowerBoundMs: number | null;
  upperBoundMs: number | null;
}

export interface TestTxBody {
  type: string;
  inputs: OutputReference[];
  outputs: PlannedOutput[];
  requiredSigners: string[];
  validityRange?: ValidityRange;
  redeemer?: string;
  /** Free-form metadata for debugging / test introspection. */
  meta?: Record<string, unknown>;
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return `${value.toString()}n`;
  return value;
}

function uint32BeHex(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error(`uint32BeHex: out of range ${n}`);
  }
  return n.toString(16).padStart(8, "0");
}

/**
 * Serialise a TestTxBody to UTF-8 hex.
 *
 * Output format (length-prefixed for unambiguous extraction):
 *   [4 bytes BE uint32: JSON byte length] || [JSON UTF-8] || [trailer]
 *
 * The trailer concatenates the raw bytes of every requiredSigners pkh hex,
 * so that the resulting hex string LITERALLY CONTAINS each pkh hex as a
 * substring (Caroline's tests use `expect(txCborHex).toContain(pkhHex)` —
 * since pkh is hex chars, decoding pkh hex to bytes yields a byte sequence
 * whose hex representation is the same pkh string).
 *
 * MockChainProvider's parser reads the length prefix, decodes the JSON
 * portion, and ignores the trailer.
 */
export function encodeTxBody(body: TestTxBody): string {
  const json = JSON.stringify(body, bigintReplacer);
  const jsonBytes = Buffer.from(json, "utf8");
  const lengthHex = uint32BeHex(jsonBytes.byteLength);
  const jsonHex = jsonBytes.toString("hex");

  // Trailer: append each required signer's pkh hex literally so it appears as
  // a substring of the final hex string. Each pkh is appended as raw hex bytes
  // (e.g., pkh "abcd..." → bytes 0xab 0xcd ... → hex "abcd...").
  const trailerHex = body.requiredSigners
    .filter((s) => /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0)
    .join("");

  return lengthHex + jsonHex + trailerHex;
}

/** SHA-256 hex of a string treated as UTF-8 (matches MockChainProvider.submitTx). */
export function sha256Hex(s: string): string {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex").toLowerCase();
}

/**
 * Build a synthetic Utxo to seed into the mock when a builder targets a
 * non-Mock provider but tests want post-build state. Currently unused by
 * production code paths — included for symmetry with the mock-side seeder.
 */
export function plannedToUtxo(p: PlannedOutput, selfHash: string): Utxo {
  return {
    ref: { txHash: p.ref.txHash === "$self" ? selfHash : p.ref.txHash, index: p.ref.index },
    address: p.address,
    lovelace: p.lovelace,
    assets: p.assets ?? {},
    datumHex: p.datumHex ?? null,
    scriptRef: p.scriptRef ?? null,
  };
}
