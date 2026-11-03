/**
 * tx/internal/plutusScript.ts — Plutus V3 script helpers without WASM.
 *
 * - plutusV3ScriptHash: blake2b-224 of the language tag 0x03 followed by the
 *   script bytes (Cardano ledger, Conway CDDL `plutus_v3_script`; the hash is
 *   also the policy ID of a minting script).
 * - applyDataParameter: the result of `aiken blueprint apply` for one Plutus
 *   Data parameter: the program `[term (con data d)]` with the same version.
 *
 * Scripts use the blueprint form (CIP-57 `compiledCode`): one CBOR byte string
 * (RFC 8949 major type 2, definite length) around the flat-encoded program.
 *
 * Flat encoding: Plutus Core specification, appendix "Serialising Plutus Core
 * terms and programs using the flat format"
 * (https://plutus.cardano.intersectmbo.org/resources/plutus-core-spec.pdf,
 * Plutus Core 1.1.0). The applied term starts 4 bits later than the original
 * term (after the Apply tag), so the padding before each byte-string constant
 * changes. The transcoder below copies every other bit unchanged and writes
 * each padding again for its new position.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, encodePlutusData, hexToBytes, type PlutusData } from "../../cbor/plutus-data.js";

const PLUTUS_V3_TAG = 0x03;

/** Term tags (4 bits). */
const TERM_VAR = 0;
const TERM_DELAY = 1;
const TERM_LAMBDA = 2;
const TERM_APPLY = 3;
const TERM_CONSTANT = 4;
const TERM_FORCE = 5;
const TERM_ERROR = 6;
const TERM_BUILTIN = 7;
const TERM_CONSTR = 8;
const TERM_CASE = 9;

/** Constant type tags (4 bits). */
const TYPE_INTEGER = 0;
const TYPE_BYTESTRING = 1;
const TYPE_STRING = 2;
const TYPE_UNIT = 3;
const TYPE_BOOL = 4;
const TYPE_LIST = 5;
const TYPE_PAIR = 6;
const TYPE_APPLY = 7;
const TYPE_DATA = 8;

type ConstantType =
  | { kind: "integer" | "bytestring" | "string" | "unit" | "bool" | "data" }
  | { kind: "list"; element: ConstantType }
  | { kind: "pair"; first: ConstantType; second: ConstantType };

class BitReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get length(): number {
    return this.bytes.length * 8;
  }

  bit(): number {
    if (this.pos >= this.length) throw new Error("flat: unexpected end of program");
    const value = (this.bytes[this.pos >> 3]! >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return value;
  }

  /** Padding `0* 1` up to a byte boundary. */
  filler(): void {
    while (this.bit() === 0) {
      // zeros of the padding
    }
    if (this.pos % 8 !== 0) throw new Error("flat: padding does not end at a byte boundary");
  }
}

class BitWriter {
  private readonly out: number[] = [];
  private current = 0;
  private used = 0;

  bit(value: number): void {
    this.current = (this.current << 1) | (value & 1);
    this.used += 1;
    if (this.used === 8) {
      this.out.push(this.current);
      this.current = 0;
      this.used = 0;
    }
  }

  bits(value: number, count: number): void {
    for (let i = count - 1; i >= 0; i -= 1) this.bit((value >> i) & 1);
  }

  /** Padding `0* 1`: the byte ends with the 1 bit (a whole 0x01 byte when already aligned). */
  filler(): void {
    while (this.used !== 7) this.bit(0);
    this.bit(1);
  }

  bytes(): Uint8Array {
    if (this.used !== 0) throw new Error("flat: output does not end at a byte boundary");
    return Uint8Array.from(this.out);
  }
}

/** Reads flat bits and writes the same value at the writer's position. */
class Transcoder {
  constructor(private readonly reader: BitReader, private readonly writer: BitWriter) {}

  bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const bit = this.reader.bit();
      this.writer.bit(bit);
      value = (value << 1) | bit;
    }
    return value;
  }

  /** A natural number: 7-bit blocks, least significant first, each after a "more blocks" bit. */
  natural(): void {
    while (this.bits(1) === 1) this.bits(7);
    this.bits(7);
  }

  /** A byte string: padding, then chunks of 1..255 bytes after their length byte, then a 0 byte. */
  bytestring(): void {
    this.reader.filler();
    this.writer.filler();
    for (let size = this.bits(8); size !== 0; size = this.bits(8)) {
      for (let i = 0; i < size; i += 1) this.bits(8);
    }
  }

  constantType(): ConstantType {
    const tags: number[] = [];
    while (this.bits(1) === 1) tags.push(this.bits(4));
    let next = 0;
    const parse = (): ConstantType => {
      const tag = tags[next++];
      switch (tag) {
        case TYPE_INTEGER: return { kind: "integer" };
        case TYPE_BYTESTRING: return { kind: "bytestring" };
        case TYPE_STRING: return { kind: "string" };
        case TYPE_UNIT: return { kind: "unit" };
        case TYPE_BOOL: return { kind: "bool" };
        case TYPE_DATA: return { kind: "data" };
        case TYPE_APPLY: {
          const operator = tags[next++];
          if (operator === TYPE_LIST) return { kind: "list", element: parse() };
          if (operator === TYPE_APPLY && tags[next++] === TYPE_PAIR) {
            const first = parse();
            return { kind: "pair", first, second: parse() };
          }
          throw new Error(`flat: unsupported type application ${String(operator)}`);
        }
        default:
          throw new Error(`flat: unsupported constant type tag ${String(tag)}`);
      }
    };
    const type = parse();
    if (next !== tags.length) throw new Error("flat: constant type has trailing tags");
    return type;
  }

  constantValue(type: ConstantType): void {
    switch (type.kind) {
      case "integer": this.natural(); return;
      case "bytestring":
      case "string":
      case "data": this.bytestring(); return;
      case "unit": return;
      case "bool": this.bits(1); return;
      case "list":
        while (this.bits(1) === 1) this.constantValue(type.element);
        return;
      case "pair":
        this.constantValue(type.first);
        this.constantValue(type.second);
        return;
    }
  }

  /** One term. Iterative, so a deep program needs no deep call stack. */
  term(): void {
    const TERM = 0;
    const LIST = 1;
    const work: number[] = [TERM];
    while (work.length > 0) {
      if (work.pop() === LIST) {
        if (this.bits(1) === 1) work.push(LIST, TERM);
        continue;
      }
      const tag = this.bits(4);
      switch (tag) {
        case TERM_VAR: this.natural(); break;
        case TERM_DELAY:
        case TERM_LAMBDA: // a de Bruijn binder has no bits
        case TERM_FORCE: work.push(TERM); break;
        case TERM_APPLY: work.push(TERM, TERM); break;
        case TERM_CONSTANT: this.constantValue(this.constantType()); break;
        case TERM_ERROR: break;
        case TERM_BUILTIN: this.bits(7); break;
        case TERM_CONSTR: this.natural(); work.push(LIST); break;
        case TERM_CASE: work.push(LIST, TERM); break;
        default: throw new Error(`flat: unknown term tag ${tag}`);
      }
    }
  }
}

function cborBytesHeader(length: number): number[] {
  if (length < 24) return [0x40 | length];
  if (length < 0x100) return [0x58, length];
  if (length < 0x10000) return [0x59, length >> 8, length & 0xff];
  return [0x5a, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

/** The flat program inside a blueprint `compiledCode` (one definite CBOR byte string). */
function unwrapCompiledCode(compiledCode: string): Uint8Array {
  const bytes = hexToBytes(compiledCode, "compiledCode");
  const first = bytes[0];
  if (first === undefined || first >> 5 !== 2) throw new Error("compiledCode: expected a CBOR byte string");
  const info = first & 0x1f;
  let offset = 1;
  let length: number;
  if (info < 24) {
    length = info;
  } else if (info <= 26) {
    const width = 1 << (info - 24);
    length = 0;
    for (let i = 0; i < width; i += 1) length = length * 256 + bytes[offset + i]!;
    offset += width;
  } else {
    throw new Error("compiledCode: expected a definite-length CBOR byte string");
  }
  if (offset + length !== bytes.length) throw new Error("compiledCode: CBOR byte string length does not match");
  return bytes.subarray(offset);
}

/** Script hash of a Plutus V3 script given as blueprint `compiledCode`: blake2b-224(0x03 || compiledCode). */
export function plutusV3ScriptHash(compiledCode: string): string {
  const script = hexToBytes(compiledCode, "compiledCode");
  const tagged = new Uint8Array(script.length + 1);
  tagged[0] = PLUTUS_V3_TAG;
  tagged.set(script, 1);
  return bytesToHex(blake2b(tagged, { dkLen: 28 }));
}

/**
 * Applies one Plutus Data parameter to a script, as `aiken blueprint apply`
 * does: `(program v [term (con data parameter)])`. Returns the new
 * `compiledCode`. Throws when the program is not valid flat.
 */
export function applyDataParameter(compiledCode: string, parameter: PlutusData): string {
  const reader = new BitReader(unwrapCompiledCode(compiledCode));
  const writer = new BitWriter();
  const copy = new Transcoder(reader, writer);
  copy.natural(); // version: major
  copy.natural(); // minor
  copy.natural(); // patch
  writer.bits(TERM_APPLY, 4);
  copy.term();
  reader.filler();
  if (reader.pos !== reader.length) throw new Error("flat: trailing bytes after the program");
  writer.bits(TERM_CONSTANT, 4);
  // Type list [data]: one element, then the end of the list.
  writer.bit(1);
  writer.bits(TYPE_DATA, 4);
  writer.bit(0);
  // The data constant: padding, the CBOR in chunks of at most 255 bytes, a 0 byte.
  const data = encodePlutusData(parameter);
  writer.filler();
  for (let offset = 0; offset < data.length; offset += 255) {
    const chunk = data.subarray(offset, offset + 255);
    writer.bits(chunk.length, 8);
    for (const byte of chunk) writer.bits(byte, 8);
  }
  writer.bits(0, 8);
  writer.filler();
  const applied = writer.bytes();
  return bytesToHex(Uint8Array.from([...cborBytesHeader(applied.length), ...applied]));
}
