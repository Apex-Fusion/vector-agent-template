/**
 * Internal readers and writers that map typed values to Plutus Data.
 *
 * Every function takes a path, so an error names the field, for example
 * "parties[1].signer: unknown constructor 3 (expected 0..2)". The public
 * codecs add their own name in front of the message.
 */

import {
  bytesToHex,
  decodePlutusDataHex,
  encodePlutusDataHex,
  hexToBytes,
  type PlutusData,
} from "./plutus-data.js";
import type { OutputReference } from "../chain/ChainProvider.js";

export interface IntRange {
  min?: bigint;
  max?: bigint;
}

/** Part 1 §5: every time is a POSIX millisecond value in [0, 253,402,300,799,999]. */
export const TIME_RANGE: IntRange = { min: 0n, max: 253_402_300_799_999n };
/** Part 1 §5: every other integer of an identity record is in [0, 2^63). */
export const NAT63_RANGE: IntRange = { min: 0n, max: (1n << 63n) - 1n };
export const NATURAL_RANGE: IntRange = { min: 0n };
const LOWER_HEX_RE = /^(?:[0-9a-f]{2})*$/;

export function at(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

export function fail(path: string, message: string): never {
  throw new Error(path ? `${path}: ${message}` : message);
}

/** Run a codec body and put the codec name in front of any error message. */
export function codec<T>(name: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${message}`, { cause: error });
  }
}

export function decodeHexData(hex: string): PlutusData {
  try {
    return decodePlutusDataHex(hex);
  } catch (error) {
    throw new Error(`malformed CBOR: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export { encodePlutusDataHex };

function describe(data: PlutusData): string {
  if (data === null || typeof data !== "object") return typeof data;
  return data.kind === "constr" ? `constructor ${data.index}` : data.kind;
}

function checkRange(value: bigint, path: string, range: IntRange): void {
  if ((range.min !== undefined && value < range.min) || (range.max !== undefined && value > range.max)) {
    fail(path, `integer ${value} is outside [${range.min ?? "-inf"}, ${range.max ?? "+inf"}]`);
  }
}

// ─── Writers ─────────────────────────────────────────────────────────

export function constr(index: number, fields: PlutusData[]): PlutusData {
  return { kind: "constr", index: BigInt(index), fields };
}

export function writeBytes(value: unknown, path: string, length?: number): PlutusData {
  if (typeof value !== "string") fail(path, `expected a hex string, got ${typeof value}`);
  const bytes = hexToBytes(value, path);
  if (length !== undefined && bytes.length !== length) fail(path, `expected ${length} bytes, got ${bytes.length}`);
  return { kind: "bytes", hex: value.toLowerCase() };
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** UTF-8 bytes of a well-formed string, as lowercase hex. */
export function utf8Hex(value: unknown, path: string): string {
  if (typeof value !== "string") fail(path, `expected a string, got ${typeof value}`);
  if (hasLoneSurrogate(value)) fail(path, "string contains an unpaired surrogate");
  return bytesToHex(new TextEncoder().encode(value));
}

/** The text of UTF-8 bytes given as hex, or null when the bytes are not valid UTF-8. */
export function utf8Text(hex: string, path: string): string | null {
  const bytes = hexToBytes(hex, path);
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

/** UTF-8 text stored as a byte string (legacy escrow and advert text fields). */
export function writeText(value: unknown, path: string): PlutusData {
  return { kind: "bytes", hex: utf8Hex(value, path) };
}

export function writeBigInt(value: unknown, path: string, range: IntRange = {}): PlutusData {
  if (typeof value !== "bigint") fail(path, `expected a bigint, got ${typeof value}`);
  checkRange(value, path, range);
  return { kind: "int", value };
}

export function writeNumber(value: unknown, path: string, range: IntRange = {}): PlutusData {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "expected a safe integer number");
  const big = BigInt(value);
  checkRange(big, path, range);
  return { kind: "int", value: big };
}

export function writeOption<T>(value: T | null, path: string, write: (inner: T, path: string) => PlutusData): PlutusData {
  if (value === undefined) fail(path, "expected a value or null, got undefined");
  return value === null ? constr(1, []) : constr(0, [write(value, path)]);
}

export function writeList<T>(value: readonly T[], path: string, write: (item: T, path: string) => PlutusData): PlutusData {
  if (!Array.isArray(value)) fail(path, "expected an array");
  return { kind: "list", items: value.map((item, i) => write(item, `${path}[${i}]`)) };
}

export function writeBool(value: unknown, path: string): PlutusData {
  if (typeof value !== "boolean") fail(path, `expected a boolean, got ${typeof value}`);
  return constr(value ? 1 : 0, []);
}

/** A constructor without fields, chosen by name. */
export function writeEnum<T extends string>(value: T, names: readonly T[], path: string): PlutusData {
  const index = names.indexOf(value);
  if (index < 0) fail(path, `unknown value ${JSON.stringify(value)} (expected ${names.join(", ")})`);
  return constr(index, []);
}

export function writeOutputReference(value: OutputReference, path: string): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an output reference");
  return constr(0, [writeBytes(value.txHash, at(path, "txHash"), 32), writeNumber(value.index, at(path, "index"), NATURAL_RANGE)]);
}

/** Look up the variant of a tagged union value and check its `type`. */
export function variantIndex<T extends string>(value: { type: T }, names: readonly T[], path: string): number {
  if (value === null || typeof value !== "object") fail(path, "expected an object with a type");
  const index = names.indexOf(value.type);
  if (index < 0) fail(path, `unknown type ${JSON.stringify(value.type)} (expected ${names.join(", ")})`);
  return index;
}

// ─── Readers ─────────────────────────────────────────────────────────

/** A constructor with an index below `variants`. */
export function readConstr(data: PlutusData, path: string, variants: number): { index: number; fields: PlutusData[] } {
  if (data === null || typeof data !== "object" || data.kind !== "constr") fail(path, `expected a constructor, got ${describe(data)}`);
  if (data.index >= BigInt(variants)) fail(path, `unknown constructor ${data.index} (expected 0..${variants - 1})`);
  return { index: Number(data.index), fields: data.fields };
}

/** The fields of constructor `index`, which must have exactly `count` fields. */
export function readFields(data: PlutusData, path: string, index: number, count: number): PlutusData[] {
  if (data === null || typeof data !== "object" || data.kind !== "constr") fail(path, `expected constructor ${index}, got ${describe(data)}`);
  if (data.index !== BigInt(index)) fail(path, `expected constructor ${index}, got constructor ${data.index}`);
  return expectFieldCount(data.fields, path, count);
}

export function expectFieldCount(fields: PlutusData[], path: string, count: number): PlutusData[] {
  if (fields.length !== count) fail(path, `expected ${count} fields, got ${fields.length}`);
  return fields;
}

export function readBytes(data: PlutusData, path: string, length?: number): string {
  if (data === null || typeof data !== "object" || data.kind !== "bytes") fail(path, `expected bytes, got ${describe(data)}`);
  if (typeof data.hex !== "string" || !LOWER_HEX_RE.test(data.hex)) fail(path, "byte string must be even-length lowercase hex");
  if (length !== undefined && data.hex.length !== length * 2) fail(path, `expected ${length} bytes, got ${data.hex.length / 2}`);
  return data.hex;
}

export function readText(data: PlutusData, path: string): string {
  const text = utf8Text(readBytes(data, path), path);
  if (text === null) fail(path, "bytes are not valid UTF-8");
  return text;
}

export function readBigInt(data: PlutusData, path: string, range: IntRange = {}): bigint {
  if (data === null || typeof data !== "object" || data.kind !== "int") fail(path, `expected an integer, got ${describe(data)}`);
  checkRange(data.value, path, range);
  return data.value;
}

export function readNumber(data: PlutusData, path: string, range: IntRange = {}): number {
  const value = readBigInt(data, path, range);
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    fail(path, `integer ${value} is outside the safe integer range`);
  }
  return Number(value);
}

export function readOption<T>(data: PlutusData, path: string, read: (inner: PlutusData, path: string) => T): T | null {
  const { index, fields } = readConstr(data, path, 2);
  if (index === 1) {
    expectFieldCount(fields, path, 0);
    return null;
  }
  return read(expectFieldCount(fields, path, 1)[0]!, path);
}

export function readList<T>(data: PlutusData, path: string, read: (item: PlutusData, path: string) => T): T[] {
  if (data === null || typeof data !== "object" || data.kind !== "list") fail(path, `expected a list, got ${describe(data)}`);
  return data.items.map((item, i) => read(item, `${path}[${i}]`));
}

export function readBool(data: PlutusData, path: string): boolean {
  const { index, fields } = readConstr(data, path, 2);
  expectFieldCount(fields, path, 0);
  return index === 1;
}

export function readEnum<T extends string>(data: PlutusData, path: string, names: readonly T[]): T {
  const { index, fields } = readConstr(data, path, names.length);
  expectFieldCount(fields, path, 0);
  return names[index]!;
}

export function readOutputReference(data: PlutusData, path: string): OutputReference {
  const [txHash, index] = readFields(data, path, 0, 2);
  return { txHash: readBytes(txHash!, at(path, "txHash"), 32), index: readNumber(index!, at(path, "index"), NATURAL_RANGE) };
}
