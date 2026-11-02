/**
 * tx/blueprint.ts — loads the Aiken blueprints (CIP-57 plutus.json) and
 * exposes script hashes + addresses.
 *
 * loadBlueprint() reads contracts/marketplace/plutus.json: the legacy escrow
 * and advert. The drain (Part 2 §9.6) keeps them until no legacy escrow is
 * left.
 *
 * loadIdentityBlueprint() reads contracts/identity-marketplace/plutus.json:
 * the new escrow and advert (Part 2 §6.1, §6.2). The new escrow has one
 * parameter, `identity_hash` (the script hash and policy ID of the identity
 * contract). It is a deployment value: the caller gives it, or the env key
 * IDENTITY_POLICY_ID holds it (the same key as the identity gateway). The
 * loader applies it to the blueprint code (applyDataParameter, byte-equal to
 * `aiken blueprint apply`), so the escrow hash and address are those of the
 * deployed script.
 *
 * Address encoding follows CIP-0019: enterprise-script address layout
 *   header byte: 0x70 (testnet, type=7 script enterprise) | 0x71 (mainnet)
 *   payload: 28-byte script hash
 * HRP: "addr_test" (testnet) | "addr" (mainnet)
 */

// Node-only modules. Use namespace imports rather than destructured names so
// Vite/Rollup, when bundling the buyer SPA, resolve them to its
// `__vite-browser-external` stub without erroring on missing named exports.
// loadBlueprint() never runs in the browser — the SPA's tx-construction path
// is server-side via /v1/* endpoints — but the static import chain reaches
// here and must parse cleanly. (vite.config.ts also aliases this module to a
// browser stub, but the namespace form is a defense-in-depth fallback.)
import * as nodeFs from "fs";
import * as nodeUrl from "url";
import * as nodePath from "path";
import { bech32 } from "bech32";
import { applyDataParameter, plutusV3ScriptHash } from "./internal/plutusScript.js";

export interface Blueprint {
  advertScriptHash: string;
  escrowScriptHash: string;
  advertScriptAddress(networkId: 0 | 1): string;
  escrowScriptAddress(networkId: 0 | 1): string;
}

/** The new escrow and advert (identity layout), with `identity_hash` applied to the escrow. */
export interface IdentityBlueprint {
  /** Script hash and policy ID of the identity contract: the escrow parameter. */
  identityHash: string;
  /** Exact address of identity records: Script(identityHash), no stake credential. */
  identityScriptAddress(networkId: 0 | 1): string;
  /** Hash of the new escrow script with identityHash applied. */
  escrowScriptHash: string;
  escrowScriptAddress(networkId: 0 | 1): string;
  /** Blueprint form (one CBOR byte string around the flat program), identityHash applied. */
  escrowCompiledCode: string;
  advertScriptHash: string;
  advertScriptAddress(networkId: 0 | 1): string;
  /** Blueprint form; the new advert has no parameter. */
  advertCompiledCode: string;
}

export interface IdentityBlueprintOptions {
  /** Default: contracts/identity-marketplace/plutus.json relative to the package root. */
  path?: string;
  /** 28-byte hex. Default: the env key IDENTITY_POLICY_ID. */
  identityHash?: string;
}

interface PlutusValidator {
  title: string;
  hash: string;
  compiledCode?: string;
  parameters?: unknown[];
}

interface PlutusJson {
  validators: PlutusValidator[];
}

const SCRIPT_ENTERPRISE_TESTNET_HEADER = 0x70;
const SCRIPT_ENTERPRISE_MAINNET_HEADER = 0x71;
const BECH32_LIMIT = 1023;
const HASH28_RE = /^[0-9a-f]{56}$/;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid hex (odd length): ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function scriptHashToAddress(scriptHashHex: string, networkId: 0 | 1): string {
  const scriptHash = hexToBytes(scriptHashHex);
  if (scriptHash.byteLength !== 28) {
    throw new Error(`script hash must be 28 bytes, got ${scriptHash.byteLength}`);
  }
  const header =
    networkId === 0
      ? SCRIPT_ENTERPRISE_TESTNET_HEADER
      : SCRIPT_ENTERPRISE_MAINNET_HEADER;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(scriptHash, 1);
  const words = bech32.toWords(payload);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  return bech32.encode(hrp, words, BECH32_LIMIT);
}

/** contracts/<project>/plutus.json, resolved from this module so the cwd does not matter. */
function defaultBlueprintPath(project: string): string {
  // From src/tx/blueprint.ts, the project root's contracts dir is at ../../../../contracts.
  const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
  return nodePath.resolve(here, "..", "..", "..", "..", "contracts", project, "plutus.json");
}

function readPlutusJson(filePath: string, caller: string): PlutusJson {
  let plutus: PlutusJson;
  try {
    const raw = nodeFs.readFileSync(filePath, "utf8");
    plutus = JSON.parse(raw) as PlutusJson;
  } catch (err) {
    throw new Error(
      `${caller}: failed to read ${filePath}: ${(err as Error).message}`,
    );
  }
  if (!plutus || !Array.isArray(plutus.validators)) {
    throw new Error(`${caller}: ${filePath} missing 'validators' array`);
  }
  return plutus;
}

function findValidatorHash(plutus: PlutusJson, prefix: string): string {
  // Match the .spend variant by title prefix. Aiken emits both `.spend` and
  // `.else` entries with the same hash, so we just take the first match.
  for (const v of plutus.validators) {
    if (typeof v.title === "string" && v.title.startsWith(prefix)) {
      if (typeof v.hash !== "string") {
        throw new Error(`plutus.json validator '${prefix}' missing hash`);
      }
      return v.hash;
    }
  }
  throw new Error(`plutus.json missing validator with title prefix '${prefix}'`);
}

/** The validator `title` with its compiled code; the code must hash to the blueprint hash. */
function compiledValidator(plutus: PlutusJson, title: string, parameters: number): string {
  const v = plutus.validators.find((entry) => entry.title === title);
  if (v === undefined || typeof v.compiledCode !== "string" || typeof v.hash !== "string") {
    throw new Error(`loadIdentityBlueprint: plutus.json has no compiled validator '${title}'`);
  }
  if ((v.parameters ?? []).length !== parameters) {
    throw new Error(`loadIdentityBlueprint: '${title}' has ${(v.parameters ?? []).length} parameters, expected ${parameters}`);
  }
  if (plutusV3ScriptHash(v.compiledCode) !== v.hash) {
    throw new Error(`loadIdentityBlueprint: the code of '${title}' does not match its blueprint hash`);
  }
  return v.compiledCode;
}

/**
 * loadBlueprint — reads plutus.json from the standard path relative to the
 * project root and returns a Blueprint.
 *
 * @param path optional explicit path to plutus.json; defaults to
 *             contracts/marketplace/plutus.json relative to the package root.
 */
export function loadBlueprint(path?: string): Blueprint {
  const filePath = path ?? defaultBlueprintPath("marketplace");
  const plutus = readPlutusJson(filePath, "loadBlueprint");

  const advertHash = findValidatorHash(plutus, "advert.");
  const escrowHash = findValidatorHash(plutus, "escrow.");

  return {
    advertScriptHash: advertHash,
    escrowScriptHash: escrowHash,
    advertScriptAddress: (networkId) => scriptHashToAddress(advertHash, networkId),
    escrowScriptAddress: (networkId) => scriptHashToAddress(escrowHash, networkId),
  };
}

const identityBlueprints = new Map<string, IdentityBlueprint>();

/**
 * loadIdentityBlueprint — reads the identity-marketplace blueprint and applies
 * `identity_hash` to the new escrow. Throws when the file, a validator or the
 * identity hash is missing.
 */
export function loadIdentityBlueprint(options: IdentityBlueprintOptions = {}): IdentityBlueprint {
  const filePath = options.path ?? defaultBlueprintPath("identity-marketplace");
  const identityHash = (options.identityHash ?? process.env.IDENTITY_POLICY_ID ?? "").toLowerCase();
  if (!HASH28_RE.test(identityHash)) {
    throw new Error(
      "loadIdentityBlueprint: the identity hash (option identityHash or env IDENTITY_POLICY_ID) must be 56 hex characters",
    );
  }
  const key = `${filePath}\n${identityHash}`;
  const cached = identityBlueprints.get(key);
  if (cached) return cached;

  const plutus = readPlutusJson(filePath, "loadIdentityBlueprint");
  const escrowCompiledCode = applyDataParameter(
    compiledValidator(plutus, "escrow.escrow.spend", 1),
    { kind: "bytes", hex: identityHash },
  );
  const advertCompiledCode = compiledValidator(plutus, "advert.advert.spend", 0);
  const escrowScriptHash = plutusV3ScriptHash(escrowCompiledCode);
  const advertScriptHash = plutusV3ScriptHash(advertCompiledCode);
  const blueprint: IdentityBlueprint = {
    identityHash,
    identityScriptAddress: (networkId) => scriptHashToAddress(identityHash, networkId),
    escrowScriptHash,
    escrowScriptAddress: (networkId) => scriptHashToAddress(escrowScriptHash, networkId),
    escrowCompiledCode,
    advertScriptHash,
    advertScriptAddress: (networkId) => scriptHashToAddress(advertScriptHash, networkId),
    advertCompiledCode,
  };
  identityBlueprints.set(key, blueprint);
  return blueprint;
}
