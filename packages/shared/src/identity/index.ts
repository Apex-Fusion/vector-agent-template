// Identity helpers: identifiers, DNS-safe form, key hashes, DID strings, allowlist tree, constants.
export {
  isVectorId, serialiseSeed, vectorIdFromSeed, dnsSafe, keyHash,
  vectorDid, legacyVectorDid, vectorDidKeyUrl, parseVectorDid, utf8ToHex, utf8FromHex,
} from "./id.js";
export type { ParsedVectorDid } from "./id.js";
export {
  allowlistLeaf, buildAllowlistTree, allowlistRoot, allowlistProof, verifyAllowlistProof,
} from "./allowlist.js";
export type { AllowlistTree } from "./allowlist.js";
export * from "./constants.js";
