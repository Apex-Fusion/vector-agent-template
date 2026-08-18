/**
 * Canonical JSON — RFC-8785 JCS subset used for request_spec_hash,
 * prompt_hash, and receipt hashing. Sorted keys, UTF-8 NFC, no whitespace.
 *
 * Scope:
 *   - Object keys are sorted lexicographically (code-unit order).
 *   - Strings are NFC-normalised (required so buyer/supplier produce bit-identical
 *     output when inputs may use composed vs decomposed forms).
 *   - No whitespace (default for JSON.stringify without indent).
 *   - Arrays preserve their order (JCS mandates this — arrays are ordered).
 *   - undefined values are dropped from objects (matches JSON.stringify).
 *   - Numbers: delegated to JSON.stringify. JCS has stricter number rules, but
 *     for M0 the callers pass well-formed JSON-compatible numbers only. M1 will
 *     tighten this if real input exercises the edge cases.
 *
 * This function is intentionally tight; M1 can expand it as needs emerge.
 */

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.normalize("NFC");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out: Record<string, unknown> = {};
  for (const [k, v] of entries) {
    out[k.normalize("NFC")] = sortKeys(v);
  }
  return out;
}

/**
 * canonicalize — produce a deterministic JSON string for hashing.
 * Same input ⇒ bit-identical output across implementations.
 */
export function canonicalize(obj: unknown): string {
  return JSON.stringify(sortKeys(obj));
}
