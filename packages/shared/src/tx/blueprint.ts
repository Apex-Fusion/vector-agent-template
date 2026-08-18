/**
 * tx/blueprint.ts — loads plutus.json and exposes script hashes + addresses.
 *
 * loadBlueprint() reads contracts/marketplace/plutus.json (compiled by Aiken),
 * extracts the advert and escrow validator hashes, and derives the corresponding
 * bech32 script addresses for testnet (networkId=0) and mainnet (networkId=1).
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

export interface Blueprint {
  advertScriptHash: string;
  escrowScriptHash: string;
  advertScriptAddress(networkId: 0 | 1): string;
  escrowScriptAddress(networkId: 0 | 1): string;
}

interface PlutusValidator {
  title: string;
  hash: string;
}

interface PlutusJson {
  validators: PlutusValidator[];
}

const SCRIPT_ENTERPRISE_TESTNET_HEADER = 0x70;
const SCRIPT_ENTERPRISE_MAINNET_HEADER = 0x71;
const BECH32_LIMIT = 1023;

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

function defaultBlueprintPath(): string {
  // Resolve relative to this module's location so the package works regardless
  // of the cwd of the calling code. From src/tx/blueprint.ts, the project
  // root's contracts dir is at ../../../../contracts/marketplace/plutus.json
  const here = nodePath.dirname(nodeUrl.fileURLToPath(import.meta.url));
  return nodePath.resolve(here, "..", "..", "..", "..", "contracts", "marketplace", "plutus.json");
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

/**
 * loadBlueprint — reads plutus.json from the standard path relative to the
 * project root and returns a Blueprint.
 *
 * @param path optional explicit path to plutus.json; defaults to
 *             contracts/marketplace/plutus.json relative to the package root.
 */
export function loadBlueprint(path?: string): Blueprint {
  const filePath = path ?? defaultBlueprintPath();
  let plutus: PlutusJson;
  try {
    const raw = nodeFs.readFileSync(filePath, "utf8");
    plutus = JSON.parse(raw) as PlutusJson;
  } catch (err) {
    throw new Error(
      `loadBlueprint: failed to read ${filePath}: ${(err as Error).message}`,
    );
  }

  if (!plutus || !Array.isArray(plutus.validators)) {
    throw new Error(`loadBlueprint: ${filePath} missing 'validators' array`);
  }

  const advertHash = findValidatorHash(plutus, "advert.");
  const escrowHash = findValidatorHash(plutus, "escrow.");

  return {
    advertScriptHash: advertHash,
    escrowScriptHash: escrowHash,
    advertScriptAddress: (networkId) => scriptHashToAddress(advertHash, networkId),
    escrowScriptAddress: (networkId) => scriptHashToAddress(escrowHash, networkId),
  };
}
