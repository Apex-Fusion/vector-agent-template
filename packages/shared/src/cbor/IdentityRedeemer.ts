/**
 * Identity contract redeemers (Part 2 §3.1). Constructor order as in the spec:
 *
 *   IdentityMint  { Register { seed }  Adopt { proof } }
 *   Actor         { ByController  ByParty { index } }
 *   IdentitySpend { Update  ChangeController  Suspend { actor }  Unsuspend { author }
 *                   Revoke { actor }  Retire  Reclaim  SetSuccessor  BumpEpoch
 *                   RecoverInit { guardians }  RecoverCancel { guardians }  RecoverFinalize }
 *
 * SetSuccessor and the later constructors have indices 7..11, so they use the
 * CBOR tags 1280..1284.
 */

import type { OutputReference } from "../chain/ChainProvider.js";
import type { PlutusData } from "./plutus-data.js";
import { signerFromData, signerToData, type Signer } from "./IdentityDatum.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, readBytes, readConstr, readFields, readList, readNumber,
  readOutputReference, variantIndex, writeBytes, writeList, writeNumber, writeOutputReference,
} from "./plutus-schema.js";

export type IdentityMint =
  | { type: "Register"; seed: OutputReference }
  /** Merkle proof against legacy_root (Part 2 §3.4): 32-byte nodes from the leaf upward. */
  | { type: "Adopt"; proof: string[] };

export type Actor = { type: "ByController" } | { type: "ByParty"; index: number };

export type IdentitySpend =
  | { type: "Update" }
  | { type: "ChangeController" }
  | { type: "Suspend"; actor: Actor }
  | { type: "Unsuspend"; author: Signer }
  | { type: "Revoke"; actor: Actor }
  | { type: "Retire" }
  | { type: "Reclaim" }
  | { type: "SetSuccessor" }
  | { type: "BumpEpoch" }
  | { type: "RecoverInit"; guardians: number[] }
  | { type: "RecoverCancel"; guardians: number[] }
  | { type: "RecoverFinalize" };

const MINTS = ["Register", "Adopt"] as const;
const ACTORS = ["ByController", "ByParty"] as const;
const SPENDS = [
  "Update", "ChangeController", "Suspend", "Unsuspend", "Revoke", "Retire", "Reclaim",
  "SetSuccessor", "BumpEpoch", "RecoverInit", "RecoverCancel", "RecoverFinalize",
] as const;
const PROOF_NODE_BYTES = 32;

function actorToData(value: Actor, path: string): PlutusData {
  const index = variantIndex(value, ACTORS, path);
  return value.type === "ByController" ? constr(index, []) : constr(index, [writeNumber(value.index, at(path, "index"))]);
}

function actorFromData(data: PlutusData, path: string): Actor {
  const { index } = readConstr(data, path, ACTORS.length);
  if (index === 0) {
    readFields(data, path, 0, 0);
    return { type: "ByController" };
  }
  const [partyIndex] = readFields(data, path, 1, 1);
  return { type: "ByParty", index: readNumber(partyIndex!, at(path, "index")) };
}

export function identityMintToData(value: IdentityMint, path = ""): PlutusData {
  const index = variantIndex(value, MINTS, path);
  return value.type === "Register"
    ? constr(index, [writeOutputReference(value.seed, at(path, "seed"))])
    : constr(index, [writeList(value.proof, at(path, "proof"), (node, q) => writeBytes(node, q, PROOF_NODE_BYTES))]);
}

export function identityMintFromData(data: PlutusData, path = ""): IdentityMint {
  const { index } = readConstr(data, path, MINTS.length);
  const [field] = readFields(data, path, index, 1);
  return index === 0
    ? { type: "Register", seed: readOutputReference(field!, at(path, "seed")) }
    : { type: "Adopt", proof: readList(field!, at(path, "proof"), (node, q) => readBytes(node, q, PROOF_NODE_BYTES)) };
}

export function identitySpendToData(value: IdentitySpend, path = ""): PlutusData {
  const index = variantIndex(value, SPENDS, path);
  switch (value.type) {
    case "Suspend":
    case "Revoke":
      return constr(index, [actorToData(value.actor, at(path, "actor"))]);
    case "Unsuspend":
      return constr(index, [signerToData(value.author, at(path, "author"))]);
    case "RecoverInit":
    case "RecoverCancel":
      return constr(index, [writeList(value.guardians, at(path, "guardians"), writeNumber)]);
    default:
      return constr(index, []);
  }
}

export function identitySpendFromData(data: PlutusData, path = ""): IdentitySpend {
  const { index } = readConstr(data, path, SPENDS.length);
  const type = SPENDS[index]!;
  switch (type) {
    case "Suspend":
    case "Revoke": {
      const [actor] = readFields(data, path, index, 1);
      return { type, actor: actorFromData(actor!, at(path, "actor")) };
    }
    case "Unsuspend": {
      const [author] = readFields(data, path, index, 1);
      return { type, author: signerFromData(author!, at(path, "author")) };
    }
    case "RecoverInit":
    case "RecoverCancel": {
      const [guardians] = readFields(data, path, index, 1);
      return { type, guardians: readList(guardians!, at(path, "guardians"), readNumber) };
    }
    default:
      readFields(data, path, index, 0);
      return { type };
  }
}

export function encodeIdentityMint(value: IdentityMint): string {
  return codec("encodeIdentityMint", () => encodePlutusDataHex(identityMintToData(value)));
}

export function decodeIdentityMint(hex: string): IdentityMint {
  return codec("decodeIdentityMint", () => identityMintFromData(decodeHexData(hex)));
}

export function encodeIdentitySpend(value: IdentitySpend): string {
  return codec("encodeIdentitySpend", () => encodePlutusDataHex(identitySpendToData(value)));
}

export function decodeIdentitySpend(hex: string): IdentitySpend {
  return codec("decodeIdentitySpend", () => identitySpendFromData(decodeHexData(hex)));
}
