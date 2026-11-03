/**
 * Allowlist Merkle tree of the adoption rule (Part 2 §3.4).
 *
 * - The leaves are blake2b_256(id) of each allowlisted identifier, sorted in
 *   ascending byte order.
 * - Each level pairs the nodes from the left. A node is
 *   blake2b_256(min(l, r) ++ max(l, r)).
 * - A last node without a pair moves up unchanged.
 * - A proof lists the paired nodes from the leaf upward.
 *
 * Verification (Adopt rule 4): x = blake2b_256(id); for each proof element s,
 * x = blake2b_256(min(x, s) ++ max(x, s)); the result equals the root.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex, hexToBytes } from "../cbor/plutus-data.js";
import { isVectorId } from "./id.js";

const NODE_RE = /^[0-9a-f]{64}$/;

export interface AllowlistTree {
  /** blake2b_256 of each identifier, in ascending order. */
  readonly leaves: readonly string[];
  readonly root: string;
  /** Proof for `id`: the paired nodes from its leaf upward. Throws when `id` is not in the tree. */
  proof(id: string): string[];
}

/** Leaf of an identifier: blake2b_256 of its 32 bytes, as hex. */
export function allowlistLeaf(id: string): string {
  if (!isVectorId(id)) throw new Error("allowlistLeaf: identifier must be 64 lowercase hexadecimal characters");
  return bytesToHex(blake2b(hexToBytes(id), { dkLen: 32 }));
}

/** blake2b_256(min(a, b) ++ max(a, b)) of two 32-byte nodes given as lowercase hex. */
function pairHash(a: string, b: string): string {
  return bytesToHex(blake2b(hexToBytes(a < b ? a + b : b + a), { dkLen: 32 }));
}

export function buildAllowlistTree(ids: readonly string[]): AllowlistTree {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error("buildAllowlistTree: the allowlist must hold at least one identifier");
  const seen = new Set<string>();
  for (const id of ids) {
    if (!isVectorId(id)) throw new Error(`buildAllowlistTree: invalid identifier ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`buildAllowlistTree: duplicate identifier ${id}`);
    seen.add(id);
  }
  const leaves = ids.map(allowlistLeaf).sort();
  const levels: string[][] = [leaves];
  for (let level = leaves; level.length > 1;) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? pairHash(level[i]!, level[i + 1]!) : level[i]!);
    levels.push(next);
    level = next;
  }
  const positions = new Map(leaves.map((leaf, i) => [leaf, i]));
  return {
    leaves,
    root: levels[levels.length - 1]![0]!,
    proof(id: string): string[] {
      let position = positions.get(allowlistLeaf(id));
      if (position === undefined) throw new Error(`allowlist proof: identifier ${id} is not in the allowlist`);
      const proof: string[] = [];
      for (const level of levels.slice(0, -1)) {
        const sibling = position ^ 1;
        if (sibling < level.length) proof.push(level[sibling]!);
        position >>= 1;
      }
      return proof;
    },
  };
}

export function allowlistRoot(ids: readonly string[]): string {
  return buildAllowlistTree(ids).root;
}

export function allowlistProof(ids: readonly string[], id: string): string[] {
  return buildAllowlistTree(ids).proof(id);
}

/** True when `proof` shows that `id` is in the tree with this root. False for any invalid input. */
export function verifyAllowlistProof(root: string, id: string, proof: readonly string[]): boolean {
  if (typeof root !== "string" || !NODE_RE.test(root) || !isVectorId(id) || !Array.isArray(proof)) return false;
  let node = allowlistLeaf(id);
  for (const sibling of proof) {
    if (typeof sibling !== "string" || !NODE_RE.test(sibling)) return false;
    node = pairHash(node, sibling);
  }
  return node === root;
}
