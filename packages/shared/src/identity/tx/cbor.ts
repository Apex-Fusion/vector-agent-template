/**
 * Minimal CBOR (RFC 8949, https://www.rfc-editor.org/rfc/rfc8949) writer and
 * reader for Conway transactions.
 *
 * The writer gives the shortest head of each item and definite lengths. The
 * caller composes larger items, so the byte layout of each transaction stays
 * explicit. The reader returns every item with its byte span in the source,
 * so a caller can keep the exact bytes of a transaction body (the transaction
 * ID is the hash of those bytes).
 *
 * Browser-safe: no Node.js API.
 */

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const MAX_UINT64 = (1n << 64n) - 1n;

function head(major: number, argument: bigint | number): Uint8Array {
  const value = BigInt(argument);
  if (value < 0n || value > MAX_UINT64) throw new RangeError(`CBOR argument out of range: ${value}`);
  const type = major << 5;
  if (value < 24n) return Uint8Array.of(type | Number(value));
  const width = value < 0x100n ? 1 : value < 0x10000n ? 2 : value < 0x100000000n ? 4 : 8;
  const out = new Uint8Array(1 + width);
  out[0] = type | (width === 1 ? 24 : width === 2 ? 25 : width === 4 ? 26 : 27);
  let rest = value;
  for (let i = width; i >= 1; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

export const cborUint = (value: bigint | number): Uint8Array => head(0, value);

/** An integer in [-2^64, 2^64 - 1] (major type 0 or 1). */
export function cborInt(value: bigint | number): Uint8Array {
  const v = BigInt(value);
  return v >= 0n ? head(0, v) : head(1, -1n - v);
}

export const cborBytes = (value: Uint8Array): Uint8Array => concatBytes([head(2, value.length), value]);

export const cborArray = (items: readonly Uint8Array[]): Uint8Array => concatBytes([head(4, items.length), ...items]);

/** A definite map. The caller gives the entries in the order to write. */
export const cborMap = (entries: ReadonlyArray<readonly [Uint8Array, Uint8Array]>): Uint8Array =>
  concatBytes([head(5, entries.length), ...entries.flatMap(([key, value]) => [key, value])]);

export const cborTag = (tag: bigint | number, item: Uint8Array): Uint8Array => concatBytes([head(6, tag), item]);

/** A Conway set: tag 258 around a definite array. */
export const cborSet = (items: readonly Uint8Array[]): Uint8Array => cborTag(258, cborArray(items));

export const CBOR_TRUE = Uint8Array.of(0xf5);
export const CBOR_NULL = Uint8Array.of(0xf6);

// ─── Reader ──────────────────────────────────────────────────────────

/** One data item and its byte span `[start, end)` in the source. */
export type CborItem =
  | { kind: "uint"; value: bigint; start: number; end: number }
  | { kind: "nint"; value: bigint; start: number; end: number }
  | { kind: "bytes"; value: Uint8Array; start: number; end: number }
  | { kind: "text"; value: string; start: number; end: number }
  | { kind: "array"; items: CborItem[]; start: number; end: number }
  | { kind: "map"; entries: Array<[CborItem, CborItem]>; start: number; end: number }
  | { kind: "tag"; tag: bigint; item: CborItem; start: number; end: number }
  | { kind: "simple"; value: number; start: number; end: number };

const MAX_NESTING = 256;

class Reader {
  offset = 0;
  constructor(readonly bytes: Uint8Array) {}

  byte(): number {
    const value = this.bytes[this.offset];
    if (value === undefined) throw new Error("CBOR: unexpected end of input");
    this.offset += 1;
    return value;
  }

  /** The argument of a head with additional information `info`; null for an indefinite length. */
  argument(info: number): bigint | null {
    if (info < 24) return BigInt(info);
    if (info === 31) return null;
    const width = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : 0;
    if (width === 0) throw new Error(`CBOR: reserved additional information ${info}`);
    let value = 0n;
    for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(this.byte());
    return value;
  }

  take(length: bigint): Uint8Array {
    const n = Number(length);
    if (!Number.isSafeInteger(n) || this.offset + n > this.bytes.length) throw new Error("CBOR: length past the end of input");
    const out = this.bytes.slice(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  atBreak(): boolean {
    if (this.bytes[this.offset] === 0xff) {
      this.offset += 1;
      return true;
    }
    return false;
  }

  item(depth: number): CborItem {
    if (depth > MAX_NESTING) throw new Error("CBOR: nesting too deep");
    const start = this.offset;
    const first = this.byte();
    const major = first >> 5;
    const info = first & 0x1f;
    switch (major) {
      case 0:
      case 1: {
        const value = this.argument(info);
        if (value === null) throw new Error("CBOR: indefinite integer");
        return { kind: major === 0 ? "uint" : "nint", value: major === 0 ? value : -1n - value, start, end: this.offset };
      }
      case 2:
      case 3: {
        const length = this.argument(info);
        let value: Uint8Array;
        if (length === null) {
          const chunks: Uint8Array[] = [];
          while (!this.atBreak()) {
            const chunk = this.item(depth + 1);
            if (major === 2 && chunk.kind === "bytes") chunks.push(chunk.value);
            else if (major === 3 && chunk.kind === "text") chunks.push(new TextEncoder().encode(chunk.value));
            else throw new Error("CBOR: bad chunk in an indefinite string");
          }
          value = concatBytes(chunks);
        } else {
          value = this.take(length);
        }
        if (major === 2) return { kind: "bytes", value, start, end: this.offset };
        return { kind: "text", value: new TextDecoder("utf-8", { fatal: true }).decode(value), start, end: this.offset };
      }
      case 4: {
        const length = this.argument(info);
        const items: CborItem[] = [];
        if (length === null) while (!this.atBreak()) items.push(this.item(depth + 1));
        else for (let i = 0n; i < length; i += 1n) items.push(this.item(depth + 1));
        return { kind: "array", items, start, end: this.offset };
      }
      case 5: {
        const length = this.argument(info);
        const entries: Array<[CborItem, CborItem]> = [];
        if (length === null) while (!this.atBreak()) entries.push([this.item(depth + 1), this.item(depth + 1)]);
        else for (let i = 0n; i < length; i += 1n) entries.push([this.item(depth + 1), this.item(depth + 1)]);
        return { kind: "map", entries, start, end: this.offset };
      }
      case 6: {
        const tag = this.argument(info);
        if (tag === null) throw new Error("CBOR: indefinite tag");
        return { kind: "tag", tag, item: this.item(depth + 1), start, end: this.offset };
      }
      default: {
        if (info >= 24) throw new Error(`CBOR: unsupported simple or float item 0x${first.toString(16)}`);
        return { kind: "simple", value: info, start, end: this.offset };
      }
    }
  }
}

/** Reads exactly one CBOR item. Throws on trailing bytes. */
export function readCbor(bytes: Uint8Array): CborItem {
  const reader = new Reader(bytes);
  const item = reader.item(0);
  if (reader.offset !== bytes.length) throw new Error("CBOR: trailing bytes");
  return item;
}
