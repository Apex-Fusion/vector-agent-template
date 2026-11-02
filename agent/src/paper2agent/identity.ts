import { createHash } from "node:crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import type { WalletKey } from "@marketplace/shared/tx";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const hash = createHash("sha512");
  for (const message of messages) hash.update(message);
  return new Uint8Array(hash.digest());
};

export function deriveSupplierKey(privateKeyHex: string, networkId: 0 | 1): WalletKey {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) throw new Error("Invalid supplier signing key");
  const publicKey = ed.getPublicKey(Buffer.from(privateKeyHex, "hex"));
  const pkh = blake2b(publicKey, { dkLen: 28 });
  return {
    privateKeyHex,
    pubKeyHex: Buffer.from(publicKey).toString("hex"),
    pubKeyHash: Buffer.from(pkh).toString("hex"),
    address: bech32.encode(networkId === 0 ? "addr_test" : "addr",
      bech32.toWords(Buffer.concat([Buffer.from([0x60 | networkId]), pkh])), 1023),
  };
}

export function checkSupplierKey(key: WalletKey, networkId: 0 | 1): void {
  const derived = deriveSupplierKey(key.privateKeyHex, networkId);
  if (key.pubKeyHex !== derived.pubKeyHex || key.pubKeyHash !== derived.pubKeyHash ||
      key.address !== derived.address) throw new Error("Supplier signing key identity mismatch");
}
