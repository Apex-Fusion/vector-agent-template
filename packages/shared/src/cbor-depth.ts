// Copied from Apex-Fusion/mcp-server `packages/shared/src/cbor-depth.ts`. Keep the two equal.
// sha256 of that file: 1ace215945073f8c729d1cb88833c0fb90a9b784155bb0c3a5deb76836ffdc6c
// Everything below the blank line is that file, byte for byte.

// Pure CBOR check. No imports and no network access: the builder and the signer can both import it.
//
// `assertCborDepth` reads the items of one CBOR value with an explicit stack and refuses a value that is nested deeper than a limit.
// The scan does not recurse, and its time is linear in the size of the input. It allocates no memory for a length that the input
// declares: a length that goes past the end of the input is refused.
//
// What counts as a level: an array, a map or a tag that is open around an item. `81 81 00` has two levels. An empty array or map
// is a level of its own. The bytes inside a byte string under tag 24 (CBOR in CBOR, as an inline datum or a reference script) are
// read as one item at the level of the tag, so their levels add to the levels around them. A byte string of that kind that is
// written in chunks (an indefinite-length byte string) is read after its chunks are joined.
//
// What else is refused: a value that is not well-formed CBOR, and a float or a simple value in a place where the decoders of the builder
// read none. Plutus data, metadata and the bytes under tag 24 hold no simple value at all (`kind: 'data'`, the default). A
// transaction holds false, true and null in a few places only (`kind: 'transaction'`): as its third and fourth item, and inside the
// certificates, votes and proposals of its body. The body of a transaction holds no empty byte string either, except as an asset name.
//
// What the scan reads: the first item of the input, and for tag 24 the first item of the byte string. The bytes after an item are
// not read, as the decoders do not read them.

/** The most levels of nesting that the builder decodes: real transactions and datums are far inside it. */
export const MAX_CBOR_DEPTH = 64;

/** Why a value was refused: it nests deeper than the limit (`depth`), or it is not CBOR that the decoders read (`format`). */
export type CborGuardReason = 'depth' | 'format';

/** A refusal of the CBOR check. An ordinary Error: its message says what was refused and why. */
export class CborGuardError extends Error {
  readonly reason: CborGuardReason;
  constructor(reason: CborGuardReason, message: string) {
    super(message);
    this.name = 'CborGuardError';
    this.reason = reason;
  }
}

export interface CborCheckOptions {
  /** Names the value in a refusal (default `The CBOR`). */
  what?: string;
  /** The most levels that the value may nest (default MAX_CBOR_DEPTH). */
  limit?: number;
  /** `data` (default): Plutus data, metadata or other CBOR without a simple value or a float. `transaction`: a transaction. */
  kind?: 'data' | 'transaction';
}

// The kinds of open frame.
const ARRAY = 1;
const MAP = 2;
const TAG = 3;
const EMBEDDED = 4;
/** `left` of a frame that has no declared count: it ends at a break code. */
const INDEFINITE = -1;
/** The tag of a byte string that holds one CBOR item. */
const EMBEDDED_CBOR_TAG = 24;
/** The additional information of false (20), true (21) and null (22). */
const FALSE = 20;
const NULL = 22;
/**
 * In a transaction, the containers that are open around the certificates, votes and proposals of the body: the transaction, the
 * body, the list of certificates, and a certificate. A false, true or null inside a list of the body (an input, an output, a
 * signer) is not part of a transaction; one inside a certificate, a vote or a proposal is.
 */
const BODY_RECORD_CONTAINERS = 4;
/** In a transaction, the containers that are open when a key of a map of the body itself is read (the transaction, the body, the map). */
const BODY_MAP_CONTAINERS = 3;

/**
 * The most levels that the first item of `input` nests, counting at most up to `limit`: throws a CborGuardError of reason `depth` for the
 * first level past `limit`, and of reason `format` for bytes that are not CBOR that the decoders read. `what` names the value in the
 * message. `simple` says which simple values and floats the value may hold: `any` (a measure, which refuses none), `transaction`
 * (false, true and null in the places of a transaction) or `none` (Plutus data, metadata, and what is under tag 24).
 */
function scan(input: Uint8Array, what: string, limit: number, simple: 'any' | 'transaction' | 'none'): number {
  const kinds: number[] = [];
  const left: number[] = []; // an array or map frame: the items still to read; a tag frame: the tag number
  const done: number[] = []; // an array or map frame: the items read so far (a map ends after a value, never after a key)
  const resume: number[] = []; // an embedded frame: where the outer bytes go on
  const outerEnd: number[] = []; // an embedded frame: where the outer bytes end
  const outerBytes: Uint8Array[] = []; // an embedded frame: the outer bytes
  let levels = 0; // the arrays, maps and tags that are open
  let containers = 0; // the arrays and maps that are open
  let deepest = 0;
  let bytes = input; // the bytes that are read now: the input, or the content of a byte string under tag 24
  let pos = 0;
  let end = bytes.length; // where the bytes that are read now end
  let embeddedLevels = 0; // the byte strings under tag 24 that are open

  const malformed = (problem: string): never => {
    throw new CborGuardError('format', `${what} is not well-formed CBOR: ${problem}.`);
  };
  const push = (kind: number, count: number): void => {
    kinds.push(kind);
    left.push(count);
    done.push(0);
    resume.push(0);
    outerEnd.push(0);
    outerBytes.push(bytes);
    if (kind === ARRAY || kind === MAP) containers += 1;
  };
  const pop = (): void => {
    const kind = kinds.pop();
    left.pop();
    done.pop();
    resume.pop();
    outerEnd.pop();
    outerBytes.pop();
    if (kind === ARRAY || kind === MAP) containers -= 1;
  };
  /** One more level around the next item. */
  const enter = (): void => {
    if (levels >= limit) throw new CborGuardError('depth', `${what} is nested deeper than ${limit} levels.`);
    levels += 1;
    if (levels > deepest) deepest = levels;
  };
  /** The argument of a header whose additional information is `info`, in the bytes that follow it. A length from 8 bytes is a double: any value of 2^32 or more is past every input. */
  const argument = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (size === 0) return malformed('a header has a reserved or an indefinite-length additional information');
    if (end - pos < size) return malformed('it ends inside a header');
    let value = 0;
    for (let i = 0; i < size; i += 1) value = value * 256 + bytes[pos + i];
    pos += size;
    return value;
  };
  /**
   * The chunks of an indefinite-length string of type `major`, from `pos` up to and past its break code: each chunk is a definite-length
   * string of the same type. Returns the length of the chunks together. `into` takes their bytes when it is given.
   */
  const chunks = (major: number, into?: Uint8Array): number => {
    let total = 0;
    for (;;) {
      if (pos >= end) return malformed('an indefinite-length string has no break code');
      const chunk = bytes[pos];
      pos += 1;
      if (chunk === 0xff) return total;
      if (chunk >> 5 !== major || (chunk & 31) === 31) return malformed('a chunk of an indefinite-length string is not a definite-length string of its type');
      const length = argument(chunk & 31);
      if (length > end - pos) return malformed('a chunk is longer than the input');
      if (into) into.set(bytes.subarray(pos, pos + length), total);
      total += length;
      pos += length;
    }
  };
  /** May the simple value or float with additional information `info` be here? */
  const simpleValueAllowed = (info: number, top: number): boolean => {
    if (simple === 'any') return true;
    if (simple === 'none' || info < FALSE || info > NULL || embeddedLevels > 0) return false;
    if (top >= 0 && kinds[top] === MAP && done[top] % 2 === 0) return false; // the key of a map
    if (kinds[0] !== ARRAY) return false; // a transaction is an array
    // [body, witness set, is valid, auxiliary data]: the third and the fourth item, and inside the records of the body.
    return containers === 1 ? done[0] >= 2 : done[0] === 0 && containers >= BODY_RECORD_CONTAINERS;
  };
  /**
   * May a byte string without bytes be here? The body of a transaction holds none, except as an asset name: an address, a hash and a
   * script are never empty. An asset name is the key of a map that is inside a map of the body (a mint, an output or a collateral
   * return), and so lies deeper than the maps of the body itself.
   */
  const emptyBytesAllowed = (top: number): boolean => {
    if (simple !== 'transaction' || embeddedLevels > 0 || kinds[0] !== ARRAY || done[0] !== 0) return true;
    return top >= 0 && kinds[top] === MAP && done[top] % 2 === 0 && containers > BODY_MAP_CONTAINERS;
  };

  for (;;) {
    if (pos >= end) malformed('it ends before an item is complete');
    const top = kinds.length - 1;
    const initial = bytes[pos];
    pos += 1;
    let complete: boolean; // does this header finish an item?

    if (initial === 0xff) {
      // A break code ends an array or a map that has no declared count, and nothing else.
      if (top < 0 || (kinds[top] !== ARRAY && kinds[top] !== MAP) || left[top] !== INDEFINITE) malformed('a break code is outside an indefinite-length array or map');
      if (kinds[top] === MAP && done[top] % 2 === 1) malformed('an indefinite-length map ends after a key');
      pop();
      levels -= 1;
      complete = true;
    } else {
      const major = initial >> 5;
      const info = initial & 31;
      switch (major) {
        case 0:
        case 1:
          argument(info);
          complete = true;
          break;
        case 2:
        case 3:
          if (major === 2 && top >= 0 && kinds[top] === TAG && left[top] === EMBEDDED_CBOR_TAG) {
            // CBOR in CBOR: the bytes are read as one item, at the levels of the tag.
            push(EMBEDDED, 0);
            const t = kinds.length - 1;
            if (info === 31) {
              const start = pos;
              const joined = new Uint8Array(chunks(major));
              pos = start;
              chunks(major, joined);
              resume[t] = pos;
              outerEnd[t] = end;
              bytes = joined;
              pos = 0;
              end = joined.length;
            } else {
              const length = argument(info);
              if (length > end - pos) malformed('a byte string is longer than the input');
              resume[t] = pos + length;
              outerEnd[t] = end;
              end = pos + length;
            }
            embeddedLevels += 1;
            complete = false;
          } else {
            let length: number;
            if (info === 31) {
              length = chunks(major);
            } else {
              length = argument(info);
              if (length > end - pos) malformed('a string is longer than the input');
              pos += length;
            }
            if (length === 0 && major === 2 && !emptyBytesAllowed(top)) throw new CborGuardError('format', `${what} holds an empty byte string in a place that a transaction fills with an address or a hash.`);
            complete = true;
          }
          break;
        case 4:
        case 5: {
          if (info === 31) {
            enter();
            push(major === 4 ? ARRAY : MAP, INDEFINITE);
            complete = false;
            break;
          }
          const count = argument(info);
          const items = major === 4 ? count : count * 2;
          // Every item takes at least one byte: a count above the bytes that are left is refused, and nothing is allocated for it.
          if (items > end - pos) malformed('an array or a map declares more items than the input has bytes');
          enter();
          if (count === 0) {
            levels -= 1; // empty: the level is counted, and it is closed at once
            complete = true;
          } else {
            push(major === 4 ? ARRAY : MAP, items);
            complete = false;
          }
          break;
        }
        case 6: {
          const tag = argument(info);
          enter();
          push(TAG, tag);
          complete = false;
          break;
        }
        default: {
          // Simple values and floats. The break code is read above.
          if (info > 27) malformed('a header has a reserved additional information');
          pos += info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
          if (pos > end) malformed('it ends inside a header');
          if (!simpleValueAllowed(info, top)) throw new CborGuardError('format', `${what} holds a simple value or a float that its decoder does not read.`);
          complete = true;
        }
      }
    }

    // An item is complete: it can finish the frames around it.
    while (complete) {
      const t = kinds.length - 1;
      if (t < 0) return deepest;
      if (kinds[t] === TAG) {
        pop();
        levels -= 1;
      } else if (kinds[t] === EMBEDDED) {
        // The first item of the bytes is complete: the rest of the bytes is not read. The byte string, and with it the tag, is complete.
        pos = resume[t];
        end = outerEnd[t];
        bytes = outerBytes[t];
        embeddedLevels -= 1;
        pop();
      } else {
        done[t] += 1;
        if (left[t] === INDEFINITE) {
          complete = false;
        } else {
          left[t] -= 1;
          if (left[t] === 0) {
            pop();
            levels -= 1;
          } else {
            complete = false;
          }
        }
      }
    }
  }
}

/**
 * The most levels that the first item of `bytes` nests (see the top of the file for what counts as a level), counted up to `limit` (by
 * default MAX_CBOR_DEPTH, as for assertCborDepth): the first level past the limit throws a CborGuardError of reason `depth`. Throws a
 * CborGuardError of reason `format` for bytes that are not well-formed CBOR. For measuring: it refuses no float and no simple value.
 */
export function cborDepth(bytes: Uint8Array, limit = MAX_CBOR_DEPTH): number {
  return scan(bytes, 'The CBOR', limit, 'any');
}

/**
 * Refuses `bytes` when the first item nests deeper than the limit, or is not CBOR that the decoders read (see the top of the file):
 * throws a CborGuardError (an ordinary Error) that names the value. Returns when the item is inside the limit.
 */
export function assertCborDepth(bytes: Uint8Array, options: CborCheckOptions = {}): void {
  scan(bytes, options.what ?? 'The CBOR', options.limit ?? MAX_CBOR_DEPTH, options.kind === 'transaction' ? 'transaction' : 'none');
}

const HEX = /^(?:[0-9a-fA-F]{2})*$/;

/** assertCborDepth for CBOR as hex text. A string that is not hex of whole bytes (either case) is refused, reason `format`. */
export function assertCborHexDepth(hex: string, options: CborCheckOptions = {}): void {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new CborGuardError('format', `${options.what ?? 'The CBOR'} is not hex of whole bytes.`);
  assertCborDepth(Buffer.from(hex, 'hex'), options);
}
