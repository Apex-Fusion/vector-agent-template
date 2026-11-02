import { createHash } from "node:crypto";
import Ajv2020, { type ValidateFunction } from "ajv/dist/2020.js";
import { Point } from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalize } from "../cbor/canonical.js";
import { buildReceipt, type Receipt } from "../receipt/build.js";
import { AGENT_RECEIPT_FIELDS, RECEIPT_FIELDS } from "../receipt/fields.js";
import { verifyReceipt } from "../receipt/verify.js";
import { isVectorId, vectorDid } from "../identity/id.js";

export const PAPER2AGENT_CAPABILITY_ID = "mcp.tool.execute.v1";
export const MAX_TOOL_INPUT_BYTES = 65536;
export const MAX_TOOL_OUTPUT_BYTES = 262144;
export const MAX_TOOL_RUNTIME_MS = 120000;
/** Discovery, Claim, Submit, and transaction construction after admission. */
export const PAPER2AGENT_SUPPLIER_OVERHEAD_MS = 150_000;
/** Also covers the buyer's 120-second Post confirmation allowance. */
export const PAPER2AGENT_DELIVERY_OVERHEAD_MS = 270_000;
export const MAX_TOOL_MANIFEST_BYTES = 131072;
export const MAX_TOOL_JSON_DEPTH = 64;
export const MAX_TOOL_JSON_NODES = 20000;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }
export interface Paper2AgentManifest {
  schema_version: 1;
  name: string;
  description: string;
  package_sha256: string;
  input_schema: JsonObject;
  output_schema: JsonObject;
  limits: { max_input_bytes: number; max_output_bytes: number; max_runtime_ms: number };
}

const HEX32 = /^[0-9a-f]{64}$/;
const MAX_DESCRIPTION_BYTES = 4096;
const MAX_SCHEMA_NODES = 2048;
const MAX_SCHEMA_EXPANSION = 10000;
const MAX_CACHED_MANIFESTS = 32;

function fail(message: string): never {
  throw new Error(`Paper2Agent: ${message}`);
}

function object(value: JsonValue, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(`${label} has missing or unknown fields`);
  }
}

// Clone before validation. The returned value, not the caller's mutable input,
// is what the executor must use. Never invoke accessors or toJSON methods.
function normalizeJson(value: unknown, maxBytes: number): JsonValue {
  let nodes = 0;
  let originalBytes = 0;
  let normalizedBytes = 0;
  const ancestors = new Set<object>();
  function addBytes(original: number, normalized = original): void {
    originalBytes += original;
    normalizedBytes += normalized;
    if (originalBytes > maxBytes || normalizedBytes > maxBytes) fail("JSON byte limit exceeded");
  }
  function text(value: string): string {
    // Check before normalization/stringification to bound allocations as well.
    if (value.length > maxBytes) fail("JSON byte limit exceeded");
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail("JSON contains an unpaired surrogate");
      } else if (code >= 0xdc00 && code <= 0xdfff) fail("JSON contains an unpaired surrogate");
    }
    const normalized = value.normalize("NFC");
    addBytes(Buffer.byteLength(JSON.stringify(value)), Buffer.byteLength(JSON.stringify(normalized)));
    return normalized;
  }
  function visit(value: unknown, depth: number): JsonValue {
    if (++nodes > MAX_TOOL_JSON_NODES) fail("JSON node limit exceeded");
    if (depth > MAX_TOOL_JSON_DEPTH) fail("JSON depth limit exceeded");
    if (value === null) { addBytes(4); return null; }
    if (typeof value === "string") return text(value);
    if (typeof value === "boolean") { addBytes(value ? 4 : 5); return value; }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("JSON numbers must be finite");
      addBytes(JSON.stringify(value).length);
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value !== "object") fail("non-JSON value");
    const isArray = Array.isArray(value);
    if (!isArray && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      fail("JSON objects must have a plain prototype");
    }
    if (ancestors.has(value)) fail("cyclic JSON value");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_TOOL_JSON_NODES + 1) fail("JSON node limit exceeded");
    addBytes(2);
    let result: JsonValue;
    if (isArray) {
      if (value.length > MAX_TOOL_JSON_NODES || keys.length !== value.length + 1) fail("invalid JSON array");
      const array: JsonValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail("invalid JSON array element");
        if (i) addBytes(1);
        array.push(visit(descriptor.value, depth + 1));
      }
      result = array;
    } else {
      const record: JsonObject = Object.create(null);
      let fields = 0;
      for (const key of keys) {
        if (typeof key !== "string") fail("JSON symbol keys are not allowed");
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !("value" in descriptor)) fail("JSON accessors or hidden fields are not allowed");
        const normalizedKey = text(key);
        if (Object.hasOwn(record, normalizedKey)) fail("normalized JSON key collision");
        addBytes(1 + (fields++ ? 1 : 0));
        record[normalizedKey] = visit(descriptor.value, depth + 1);
      }
      result = record;
    }
    ancestors.delete(value);
    return result;
  }
  return visit(value, 0);
}

function digest(value: JsonValue | Paper2AgentManifest): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

function hash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HEX32.test(value)) fail(`${label} must be 64 lowercase hex characters`);
}

function limit(value: JsonValue | undefined, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

// AJV supplies JSON Schema semantics. This preflight only bounds its execution:
// 2020-12, local acyclic JSON-pointer references, no regex/format evaluation.
function checkSchema(root: JsonObject): void {
  if (root.type !== "object") fail("schema root type must be object");
  const graph = new Map<JsonObject, JsonObject[]>();
  function collect(value: JsonValue): void {
    if (typeof value === "boolean") return;
    const schema = object(value, "schema");
    if (graph.has(schema)) return;
    if (graph.size >= MAX_SCHEMA_NODES) fail("schema node limit exceeded");
    const children: JsonObject[] = [];
    graph.set(schema, children);
    for (const key of ["pattern", "patternProperties", "format", "$async", "$id", "$anchor", "$dynamicAnchor", "$dynamicRef", "$recursiveRef"]) {
      if (Object.hasOwn(schema, key)) fail(`schema keyword ${key} is not allowed`);
    }
    if (schema.$schema !== undefined && schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
      fail("only JSON Schema 2020-12 is supported");
    }
    function child(value: JsonValue): void {
      collect(value);
      if (typeof value !== "boolean") children.push(object(value, "schema"));
    }
    for (const key of ["properties", "$defs", "definitions", "dependentSchemas"]) {
      if (schema[key] !== undefined) {
        for (const value of Object.values(object(schema[key], key))) child(value);
      }
    }
    for (const key of ["additionalProperties", "unevaluatedProperties", "unevaluatedItems", "contentSchema", "contains", "propertyNames", "not", "if", "then", "else"]) {
      if (schema[key] !== undefined) child(schema[key]);
    }
    for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      if (schema[key] !== undefined) {
        if (!Array.isArray(schema[key])) fail(`${key} must be an array`);
        for (const value of schema[key]) child(value);
      }
    }
    if (schema.items !== undefined) child(schema.items);
    if (schema.dependencies !== undefined) {
      for (const value of Object.values(object(schema.dependencies, "dependencies"))) {
        if (!Array.isArray(value)) child(value);
      }
    }
  }
  collect(root);
  for (const [schema, edges] of graph) {
    if (schema.$ref === undefined) continue;
    if (typeof schema.$ref !== "string" || !(schema.$ref === "#" || schema.$ref.startsWith("#/"))) {
      fail("schema references must be local JSON pointers");
    }
    let pointer: string;
    try { pointer = decodeURIComponent(schema.$ref.slice(1)); }
    catch { fail("invalid schema reference encoding"); }
    let target: JsonValue = root;
    for (const part of pointer === "" ? [] : pointer.slice(1).split("/")) {
      if (/~(?:[^01]|$)/.test(part)) fail("invalid schema JSON pointer");
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (target === null || typeof target !== "object" || !Object.hasOwn(target, key)) fail("unresolved schema reference");
      target = (target as JsonObject)[key];
    }
    if (typeof target === "boolean") continue;
    const referenced = object(target, "referenced schema");
    if (!graph.has(referenced)) fail("reference must target a schema location");
    edges.push(referenced);
  }
  const visiting = new Set<JsonObject>();
  const costs = new Map<JsonObject, { expansion: number; height: number }>();
  function cost(schema: JsonObject, depth: number): { expansion: number; height: number } {
    if (visiting.has(schema)) fail("cyclic schema reference");
    if (depth > MAX_TOOL_JSON_DEPTH) fail("schema reference depth limit exceeded");
    const cached = costs.get(schema);
    if (cached !== undefined) {
      if (depth + cached.height > MAX_TOOL_JSON_DEPTH) fail("schema reference depth limit exceeded");
      return cached;
    }
    visiting.add(schema);
    const total = { expansion: 1, height: 0 };
    for (const child of graph.get(schema)!) {
      const childCost = cost(child, depth + 1);
      total.expansion += childCost.expansion;
      total.height = Math.max(total.height, childCost.height + 1);
      if (total.expansion > MAX_SCHEMA_EXPANSION) fail("schema expansion limit exceeded");
    }
    visiting.delete(schema);
    costs.set(schema, total);
    return total;
  }
  cost(root, 0);
}

interface Validators { input: ValidateFunction; output: ValidateFunction }
const validators = new Map<string, Validators>();
function compiled(manifest: Paper2AgentManifest): Validators {
  const key = canonicalize(manifest);
  const cached = validators.get(key);
  if (cached) return cached;
  checkSchema(manifest.input_schema);
  checkSchema(manifest.output_schema);
  // Separate instances avoid collisions in root schemas. No fetch/loadSchema,
  // mutation, regex formats, or $data code paths are enabled.
  function compile(schema: JsonObject): ValidateFunction {
    const ajv = new Ajv2020({
      strict: true, strictRequired: false, allErrors: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false,
      ownProperties: true, inlineRefs: false, loopRequired: 32, loopEnum: 32,
    });
    return ajv.compile(schema);
  }
  const result = { input: compile(manifest.input_schema), output: compile(manifest.output_schema) };
  if (validators.size >= MAX_CACHED_MANIFESTS) validators.delete(validators.keys().next().value!);
  validators.set(key, result);
  return result;
}

export function parsePaper2AgentManifest(value: unknown): Paper2AgentManifest {
  const parsed = object(normalizeJson(value, MAX_TOOL_MANIFEST_BYTES), "manifest");
  exactKeys(parsed, ["schema_version", "name", "description", "package_sha256", "input_schema", "output_schema", "limits"], "manifest");
  if (parsed.schema_version !== 1) fail("unsupported manifest schema_version");
  if (typeof parsed.name !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(parsed.name)) fail("invalid MCP tool name");
  if (typeof parsed.description !== "string" || Buffer.byteLength(parsed.description) > MAX_DESCRIPTION_BYTES) fail("invalid manifest description");
  hash(parsed.package_sha256, "package_sha256");
  object(parsed.input_schema, "input_schema");
  object(parsed.output_schema, "output_schema");
  const limits = object(parsed.limits, "limits");
  exactKeys(limits, ["max_input_bytes", "max_output_bytes", "max_runtime_ms"], "limits");
  limit(limits.max_input_bytes, MAX_TOOL_INPUT_BYTES, "max_input_bytes");
  limit(limits.max_output_bytes, MAX_TOOL_OUTPUT_BYTES, "max_output_bytes");
  limit(limits.max_runtime_ms, MAX_TOOL_RUNTIME_MS, "max_runtime_ms");
  const manifest = parsed as unknown as Paper2AgentManifest;
  compiled(manifest);
  return manifest;
}

export function paper2AgentManifestHash(manifest: Paper2AgentManifest): string {
  return digest(parsePaper2AgentManifest(manifest));
}
export function paper2AgentModel(manifest: Paper2AgentManifest): string {
  return `paper2agent:${paper2AgentManifestHash(manifest)}`;
}
export function paper2AgentToolName(manifest: Paper2AgentManifest): string {
  const parsed = parsePaper2AgentManifest(manifest);
  return `p2a_${parsed.name}_${digest(parsed).slice(0, 16)}`;
}

function validate(manifest: Paper2AgentManifest, value: unknown, direction: "input" | "output"): JsonObject {
  const parsed = parsePaper2AgentManifest(manifest);
  const result = object(normalizeJson(value, parsed.limits[direction === "input" ? "max_input_bytes" : "max_output_bytes"]), direction);
  const validator = compiled(parsed)[direction];
  if (!validator(result)) fail(`${direction} does not match its JSON schema`);
  return result;
}
export function validatePaper2AgentInput(manifest: Paper2AgentManifest, value: unknown): JsonObject {
  return validate(manifest, value, "input");
}
export function validatePaper2AgentOutput(manifest: Paper2AgentManifest, value: unknown): JsonObject {
  return validate(manifest, value, "output");
}
export function paper2AgentRequestHash(manifestHash: string, input: JsonObject): string {
  hash(manifestHash, "manifest_hash");
  return digest({ capability_id: PAPER2AGENT_CAPABILITY_ID, manifest_hash: manifestHash,
    input: object(normalizeJson(input, MAX_TOOL_INPUT_BYTES), "input") });
}
export function paper2AgentResultHash(manifestHash: string, requestHash: string, result: JsonObject): string {
  hash(manifestHash, "manifest_hash");
  hash(requestHash, "request_hash");
  return digest({ capability_id: PAPER2AGENT_CAPABILITY_ID, manifest_hash: manifestHash, request_hash: requestHash,
    result: object(normalizeJson(result, MAX_TOOL_OUTPUT_BYTES), "result") });
}
export function paper2AgentRequestSpecHash(manifest: Paper2AgentManifest): string {
  return digest({ capability_id: PAPER2AGENT_CAPABILITY_ID, max_output_tokens: 0, model: paper2AgentModel(manifest) });
}
export function parsePaper2AgentRequest(manifest: Paper2AgentManifest, value: unknown): { manifest_hash: string; input: JsonObject } {
  // Envelope overhead is independent of the advertised input limit.
  const request = object(normalizeJson(value, MAX_TOOL_INPUT_BYTES + 256), "request");
  exactKeys(request, ["manifest_hash", "input"], "request");
  hash(request.manifest_hash, "manifest_hash");
  if (request.manifest_hash !== paper2AgentManifestHash(manifest)) fail("request manifest mismatch");
  // Recheck the original input so NFC cannot hide an over-limit wire value.
  const input = Object.getOwnPropertyDescriptor(value, "input")!.value;
  return { manifest_hash: request.manifest_hash, input: validatePaper2AgentInput(manifest, input) };
}
export function paper2AgentSupplierPkh(publicKeyHex: string): string {
  hash(publicKeyHex, "public key");
  const point = Point.fromHex(publicKeyHex, false);
  if (point.isSmallOrder() || !point.isTorsionFree()) fail("invalid supplier signing key");
  return bytesToHex(blake2b(hexToBytes(publicKeyHex), { dkLen: 28 }));
}
/**
 * Verify a tool receipt against its escrow. A new escrow (agentId set) needs a
 * 9-field receipt whose agent_did names that agent; a legacy escrow (agentId
 * null or absent) needs the 8 legacy fields (Part 2 §6.3).
 */
export function verifyPaper2AgentReceipt(args: {
  manifest: Paper2AgentManifest; input: JsonObject; result: JsonObject;
  receipt: Receipt; signature: string; publicKeyHex: string;
  supplierPkh: string; escrowRef: string;
  /** agent_id of a new escrow datum; null or absent for a legacy escrow. */
  agentId?: string | null;
}): void {
  const manifest = parsePaper2AgentManifest(args.manifest);
  const input = validatePaper2AgentInput(manifest, args.input);
  const result = validatePaper2AgentOutput(manifest, args.result);
  const manifestHash = digest(manifest);
  const requestHash = paper2AgentRequestHash(manifestHash, input);
  if (typeof args.supplierPkh !== "string" || !/^[0-9a-f]{56}$/.test(args.supplierPkh) ||
      paper2AgentSupplierPkh(args.publicKeyHex) !== args.supplierPkh) fail("supplier public key does not match PKH");
  if (typeof args.escrowRef !== "string" || !/^[0-9a-f]{64}#(?:0|[1-9][0-9]{0,9})$/.test(args.escrowRef)) fail("invalid escrow reference");
  const agentId = args.agentId ?? null;
  if (agentId !== null && !isVectorId(agentId)) fail("invalid escrow agent identifier");
  const raw = object(normalizeJson(args.receipt, 4096), "receipt");
  exactKeys(raw, agentId === null ? RECEIPT_FIELDS : AGENT_RECEIPT_FIELDS, "receipt");
  const receipt = buildReceipt(raw as unknown as Receipt);
  if (agentId !== null && receipt.agent_did !== vectorDid(agentId)) fail("receipt agent DID does not match the escrow agent");
  if (receipt.supplier_pkh !== args.supplierPkh || receipt.escrow_ref !== args.escrowRef ||
      receipt.model !== `paper2agent:${manifestHash}` || receipt.prompt_hash !== requestHash ||
      receipt.response_hash !== paper2AgentResultHash(manifestHash, requestHash, result)) fail("receipt commitment mismatch");
  if (receipt.prompt_tokens !== 0 || receipt.completion_tokens !== 0) fail("tool receipt token counts must be zero");
  if (!Number.isSafeInteger(receipt.wallclock_ms) || receipt.wallclock_ms > manifest.limits.max_runtime_ms) fail("invalid receipt runtime");
  if (!verifyReceipt({ receipt, signature: args.signature }, args.publicKeyHex)) fail("invalid receipt signature");
}
