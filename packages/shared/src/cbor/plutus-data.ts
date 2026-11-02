/**
 * Plutus Data: a typed value, its canonical CBOR encoding and a strict decoder.
 *
 * The encoder writes the same bytes as Plutus `serialiseData` and Aiken
 * `cbor.serialise`:
 * - A non-empty list, and the fields of a constructor, use an indefinite-length
 *   array. An empty list uses the definite empty array 0x80.
 * - An integer uses the shortest head. Outside 64 bits it uses tag 2 or 3 with
 *   its big-endian magnitude.
 * - A byte string longer than 64 bytes goes in 64-byte chunks.
 * - Constructor 0..6 uses tag 121..127, 7..127 uses tag 1280..1400, and every
 *   other index uses tag 102 with [index, fields].
 * - A map is a definite-length map. Its entries keep their order.
 *
 * The identifier derivation (Part 1 §3.1) and the identity contracts hash these
 * bytes, so the identity codecs use this encoder. The legacy escrow and advert
 * codecs keep their cbor-x encoding (plutus-encoder.ts).
 *
 * The decoder accepts each form that the ledger accepts: definite and
 * indefinite arrays and maps, chunked byte strings and integer heads that are
 * longer than necessary. It rejects text strings, floats, simple values, other
 * tags, byte-string chunks longer than 64 bytes and trailing bytes.
 */

export type PlutusData =
  | { kind: "constr"; index: bigint; fields: PlutusData[] }
  | { kind: "map"; entries: Array<[PlutusData, PlutusData]> }
  | { kind: "list"; items: PlutusData[] }
  | { kind: "int"; value: bigint }
  | { kind: "bytes"; hex: string };

const CHUNK = 64;
const MAX_DEPTH = 1000;
const TWO_64 = 1n << 64n;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

export function hexToBytes(hex: string, label = "hex"): Uint8Array {
  if (typeof hex !== "string" || !HEX_RE.test(hex)) {
    throw new Error(`${label}: expected an even-length hex string`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

// ─── Encoder ─────────────────────────────────────────────────────────

class Writer {
  private readonly out: number[] = [];

  head(major: number, value: bigint): void {
    const m = major << 5;
    if (value < 24n) {
      this.out.push(m | Number(value));
    } else if (value < 0x100n) {
      this.out.push(m | 24, Number(value));
    } else if (value < 0x10000n) {
      this.out.push(m | 25, Number(value >> 8n), Number(value & 0xffn));
    } else if (value < 0x100000000n) {
      this.out.push(m | 26);
      for (let shift = 24n; shift >= 0n; shift -= 8n) this.out.push(Number((value >> shift) & 0xffn));
    } else {
      this.out.push(m | 27);
      for (let shift = 56n; shift >= 0n; shift -= 8n) this.out.push(Number((value >> shift) & 0xffn));
    }
  }

  raw(...bytes: number[]): void {
    this.out.push(...bytes);
  }

  bytes(value: Uint8Array): void {
    if (value.length <= CHUNK) {
      this.head(2, BigInt(value.length));
      for (const byte of value) this.out.push(byte);
      return;
    }
    this.out.push(0x5f);
    for (let offset = 0; offset < value.length; offset += CHUNK) {
      const chunk = value.subarray(offset, offset + CHUNK);
      this.head(2, BigInt(chunk.length));
      for (const byte of chunk) this.out.push(byte);
    }
    this.out.push(0xff);
  }

  result(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

function magnitudeBytes(value: bigint): Uint8Array {
  const digits: number[] = [];
  for (let rest = value; rest > 0n; rest >>= 8n) digits.unshift(Number(rest & 0xffn));
  return Uint8Array.from(digits);
}

function encodeInto(w: Writer, data: PlutusData, path: string, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`${path}: Plutus Data nests deeper than ${MAX_DEPTH} levels`);
  if (data === null || typeof data !== "object") throw new Error(`${path}: expected a Plutus Data value`);
  const kind: unknown = data.kind;
  switch (data.kind) {
    case "int": {
      const v = data.value;
      if (typeof v !== "bigint") throw new Error(`${path}: integer value must be a bigint`);
      if (v >= 0n) {
        if (v < TWO_64) w.head(0, v);
        else { w.head(6, 2n); w.bytes(magnitudeBytes(v)); }
      } else {
        const n = -1n - v;
        if (n < TWO_64) w.head(1, n);
        else { w.head(6, 3n); w.bytes(magnitudeBytes(n)); }
      }
      return;
    }
    case "bytes":
      w.bytes(hexToBytes(data.hex, path));
      return;
    case "list":
      if (!Array.isArray(data.items)) throw new Error(`${path}: list items must be an array`);
      encodeList(w, data.items, path, depth);
      return;
    case "map":
      if (!Array.isArray(data.entries)) throw new Error(`${path}: map entries must be an array`);
      w.head(5, BigInt(data.entries.length));
      data.entries.forEach((entry, i) => {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error(`${path}{${i}}: map entry must be a [key, value] pair`);
        encodeInto(w, entry[0], `${path}{${i}}.key`, depth + 1);
        encodeInto(w, entry[1], `${path}{${i}}.value`, depth + 1);
      });
      return;
    case "constr": {
      const index = data.index;
      if (typeof index !== "bigint" || index < 0n || index >= TWO_64) {
        throw new Error(`${path}: constructor index must be a bigint in [0, 2^64)`);
      }
      if (!Array.isArray(data.fields)) throw new Error(`${path}: constructor fields must be an array`);
      if (index <= 6n) {
        w.head(6, 121n + index);
      } else if (index <= 127n) {
        w.head(6, 1280n + index - 7n);
      } else {
        w.head(6, 102n);
        w.raw(0x82);
        w.head(0, index);
      }
      encodeList(w, data.fields, path, depth);
      return;
    }
    default:
      throw new Error(`${path}: unknown Plutus Data kind ${String(kind)}`);
  }
}

function encodeList(w: Writer, items: PlutusData[], path: string, depth: number): void {
  if (items.length === 0) {
    w.raw(0x80);
    return;
  }
  w.raw(0x9f);
  items.forEach((item, i) => encodeInto(w, item, `${path}[${i}]`, depth + 1));
  w.raw(0xff);
}

/** Canonical Plutus Data CBOR, byte-equal to Plutus `serialiseData`. */
export function encodePlutusData(data: PlutusData): Uint8Array {
  const w = new Writer();
  encodeInto(w, data, "data", 0);
  return w.result();
}

export function encodePlutusDataHex(data: PlutusData): string {
  return bytesToHex(encodePlutusData(data));
}

// ─── Decoder ─────────────────────────────────────────────────────────

class Reader {
  pos = 0;
  constructor(private readonly input: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.input.length;
  }

  peek(): number {
    if (this.pos >= this.input.length) throw new Error(`unexpected end of input at byte ${this.pos}`);
    return this.input[this.pos]!;
  }

  byte(): number {
    const value = this.peek();
    this.pos++;
    return value;
  }

  take(length: number): Uint8Array {
    if (this.pos + length > this.input.length) throw new Error(`unexpected end of input at byte ${this.pos}`);
    const out = this.input.slice(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  /** Major type and argument. `value` is null for an indefinite length. */
  head(): { major: number; value: bigint | null; at: number } {
    const at = this.pos;
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;
    if (info < 24) return { major, value: BigInt(info), at };
    if (info === 31) {
      if (major === 0 || major === 1 || major === 6) throw new Error(`invalid indefinite length for major type ${major} at byte ${at}`);
      return { major, value: null, at };
    }
    if (info > 27) throw new Error(`reserved additional information ${info} at byte ${at}`);
    let value = 0n;
    for (const byte of this.take(1 << (info - 24))) value = (value << 8n) | BigInt(byte);
    return { major, value, at };
  }

  isBreak(): boolean {
    return this.peek() === 0xff;
  }
}

function count(value: bigint, at: number): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`length too large at byte ${at}`);
  return Number(value);
}

function readByteString(r: Reader, length: bigint | null, at: number): Uint8Array {
  if (length !== null) {
    const n = count(length, at);
    if (n > CHUNK) throw new Error(`byte string of ${n} bytes at byte ${at} is not split into chunks of at most ${CHUNK} bytes`);
    return r.take(n);
  }
  const parts: Uint8Array[] = [];
  let total = 0;
  while (!r.isBreak()) {
    const chunk = r.head();
    if (chunk.major !== 2 || chunk.value === null) throw new Error(`indefinite byte string at byte ${at} holds a chunk that is not a definite byte string`);
    const part = readByteString(r, chunk.value, chunk.at);
    parts.push(part);
    total += part.length;
  }
  r.byte();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function readItems(r: Reader, length: bigint | null, depth: number): PlutusData[] {
  const items: PlutusData[] = [];
  if (length === null) {
    while (!r.isBreak()) items.push(readData(r, depth + 1));
    r.byte();
  } else {
    for (let i = 0n; i < length; i++) items.push(readData(r, depth + 1));
  }
  return items;
}

function readFieldList(r: Reader, depth: number, at: number): PlutusData[] {
  const head = r.head();
  if (head.major !== 4) throw new Error(`constructor at byte ${at} has no field array`);
  return readItems(r, head.value, depth);
}

function readData(r: Reader, depth: number): PlutusData {
  if (depth > MAX_DEPTH) throw new Error(`Plutus Data nests deeper than ${MAX_DEPTH} levels`);
  const { major, value, at } = r.head();
  switch (major) {
    case 0:
      return { kind: "int", value: value! };
    case 1:
      return { kind: "int", value: -1n - value! };
    case 2:
      return { kind: "bytes", hex: bytesToHex(readByteString(r, value, at)) };
    case 3:
      throw new Error(`text string at byte ${at} is not Plutus Data`);
    case 4:
      return { kind: "list", items: readItems(r, value, depth) };
    case 5: {
      const entries: Array<[PlutusData, PlutusData]> = [];
      if (value === null) {
        while (!r.isBreak()) entries.push([readData(r, depth + 1), readData(r, depth + 1)]);
        r.byte();
      } else {
        for (let i = 0n; i < value; i++) entries.push([readData(r, depth + 1), readData(r, depth + 1)]);
      }
      return { kind: "map", entries };
    }
    case 6: {
      const tag = value!;
      if (tag >= 121n && tag <= 127n) return { kind: "constr", index: tag - 121n, fields: readFieldList(r, depth, at) };
      if (tag >= 1280n && tag <= 1400n) return { kind: "constr", index: tag - 1280n + 7n, fields: readFieldList(r, depth, at) };
      if (tag === 102n) {
        const pair = r.head();
        if (pair.major !== 4 || pair.value !== 2n) throw new Error(`tag 102 at byte ${at} must wrap a definite array of 2 items`);
        const index = r.head();
        if (index.major !== 0) throw new Error(`tag 102 at byte ${at} needs an unsigned constructor index`);
        return { kind: "constr", index: index.value!, fields: readFieldList(r, depth, at) };
      }
      if (tag === 2n || tag === 3n) {
        const payload = r.head();
        if (payload.major !== 2) throw new Error(`bignum tag ${tag} at byte ${at} must wrap a byte string`);
        let magnitude = 0n;
        for (const byte of readByteString(r, payload.value, payload.at)) magnitude = (magnitude << 8n) | BigInt(byte);
        return { kind: "int", value: tag === 2n ? magnitude : -1n - magnitude };
      }
      throw new Error(`tag ${tag} at byte ${at} is not Plutus Data`);
    }
    default:
      throw new Error(`simple value or float at byte ${at} is not Plutus Data`);
  }
}

/** Strict Plutus Data decoder. Throws on any input that is not exactly one Plutus Data item. */
export function decodePlutusData(bytes: Uint8Array): PlutusData {
  if (!(bytes instanceof Uint8Array)) throw new Error("expected CBOR bytes");
  const r = new Reader(bytes);
  const data = readData(r, 0);
  if (!r.done) throw new Error(`trailing bytes after Plutus Data at byte ${r.pos}`);
  return data;
}

export function decodePlutusDataHex(hex: string): PlutusData {
  if (typeof hex !== "string" || hex.length === 0) throw new Error("expected a non-empty hex string");
  return decodePlutusData(hexToBytes(hex, "CBOR"));
}
