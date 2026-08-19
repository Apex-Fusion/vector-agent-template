/**
 * Plutus-compliant CBOR encoder — shared low-level machinery.
 *
 * Why this file exists
 * --------------------
 * Plutus validators reject CBOR tag 64 (0xd8 0x40) wrapping of bytestrings.
 * They require BARE major-type-2 bytestrings (0x40..0x57 / 0x58 <len> / 0x59 <len:u16>
 * / 0x5a <len:u32>). cbor-x's default behaviour wraps every Uint8Array in tag 64,
 * which makes the resulting hex unusable on-chain.
 *
 * cbor-x exposes an `Encoder` option `tagUint8Array: false` that disables the
 * tag-64 wrapping. We construct ONE Encoder instance with that option set, and
 * also wire the Plutus-convention Tag extension (`registerPlutusTagExtension`)
 * so Constr-style tags encode correctly.
 *
 * Sharing rationale (fixture isolation discipline preserved)
 * ----------------------------------------------------------
 * The "no shared source of truth" rule from ARCHITECTURE.md §7.2 applies to
 * fixture-builder LOGIC — i.e. how each side constructs the datum from the
 * spec. It does NOT apply to low-level CBOR machinery (Tag-extension wiring
 * and the `tagUint8Array: false` flag), which are environmental rather than
 * semantic. Both production codecs and fixture builders import this helper so
 * they all agree on byte-level emission, while still independently constructing
 * the datum payload from the spec.
 */

import { Encoder } from "cbor-x";
import { registerPlutusTagExtension } from "./plutus-tag.js";

// Register the Plutus Tag extension once, globally (cbor-x extension registry
// is process-global; the registration is idempotent).
registerPlutusTagExtension();

/**
 * The shared Plutus encoder. Disables tag-64 wrapping for `Uint8Array`, so byte
 * fields emit as bare major-type-2 bytestrings as Plutus requires.
 */
const plutusEncoder = new Encoder({ tagUint8Array: false });

/**
 * encodePlutus — encode a value (Plutus-shaped Tags + bytes/ints/strings)
 * into a CBOR byte buffer with bare bytestrings (no tag 64).
 *
 * Returned buffer is a `Uint8Array` view; callers that need hex should use
 * their own bytesToHex helper.
 */
export function encodePlutus(value: unknown): Uint8Array {
  return plutusEncoder.encode(value);
}
