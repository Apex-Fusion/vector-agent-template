/**
 * Plutus Data form of a ledger address (Aiken stdlib `cardano/address`):
 *
 *   Address         = Constr 0 [payment_credential, Option<StakeCredential>]
 *   Credential      = VerificationKey(hash) Constr 0 [hash] | Script(hash) Constr 1 [hash]
 *   StakeCredential = Inline(Credential) Constr 0 [credential]
 *                   | Pointer { slot_number, transaction_index, certificate_index } Constr 1 [int, int, int]
 *
 * Hashes are 28 bytes. The bech32 helpers convert Shelley payment addresses
 * (CIP-19 types 0-7). Byron and reward addresses have no Plutus Address form.
 */

import { bech32 } from "bech32";
import type { NetworkId } from "../network.js";
import { bytesToHex, hexToBytes, type PlutusData } from "./plutus-data.js";
import {
  at, codec, constr, decodeHexData, encodePlutusDataHex, fail, readBigInt, readBytes, readConstr,
  readFields, readOption, variantIndex, writeBigInt, writeBytes, writeOption,
} from "./plutus-schema.js";

export type PlutusCredential =
  | { type: "VerificationKey"; hash: string }
  | { type: "Script"; hash: string };

export type PlutusStakeCredential =
  | { type: "Inline"; credential: PlutusCredential }
  | { type: "Pointer"; slotNumber: bigint; transactionIndex: bigint; certificateIndex: bigint };

export interface PlutusAddress {
  paymentCredential: PlutusCredential;
  stakeCredential: PlutusStakeCredential | null;
}

const CREDENTIALS = ["VerificationKey", "Script"] as const;
const STAKE_CREDENTIALS = ["Inline", "Pointer"] as const;
const HASH_BYTES = 28;

// ─── Plutus Data ─────────────────────────────────────────────────────

export function credentialToData(value: PlutusCredential, path: string): PlutusData {
  const index = variantIndex(value, CREDENTIALS, path);
  return constr(index, [writeBytes(value.hash, at(path, "hash"), HASH_BYTES)]);
}

export function credentialFromData(data: PlutusData, path: string): PlutusCredential {
  const { index } = readConstr(data, path, CREDENTIALS.length);
  const [hash] = readFields(data, path, index, 1);
  return { type: CREDENTIALS[index]!, hash: readBytes(hash!, at(path, "hash"), HASH_BYTES) };
}

function stakeCredentialToData(value: PlutusStakeCredential, path: string): PlutusData {
  const index = variantIndex(value, STAKE_CREDENTIALS, path);
  if (value.type === "Inline") return constr(index, [credentialToData(value.credential, at(path, "credential"))]);
  return constr(index, [
    writeBigInt(value.slotNumber, at(path, "slotNumber")),
    writeBigInt(value.transactionIndex, at(path, "transactionIndex")),
    writeBigInt(value.certificateIndex, at(path, "certificateIndex")),
  ]);
}

function stakeCredentialFromData(data: PlutusData, path: string): PlutusStakeCredential {
  const { index } = readConstr(data, path, STAKE_CREDENTIALS.length);
  if (index === 0) {
    const [credential] = readFields(data, path, 0, 1);
    return { type: "Inline", credential: credentialFromData(credential!, at(path, "credential")) };
  }
  const [slot, tx, cert] = readFields(data, path, 1, 3);
  return {
    type: "Pointer",
    slotNumber: readBigInt(slot!, at(path, "slotNumber")),
    transactionIndex: readBigInt(tx!, at(path, "transactionIndex")),
    certificateIndex: readBigInt(cert!, at(path, "certificateIndex")),
  };
}

export function plutusAddressToData(value: PlutusAddress, path = ""): PlutusData {
  if (value === null || typeof value !== "object") fail(path, "expected an address");
  return constr(0, [
    credentialToData(value.paymentCredential, at(path, "paymentCredential")),
    writeOption(value.stakeCredential, at(path, "stakeCredential"), stakeCredentialToData),
  ]);
}

export function plutusAddressFromData(data: PlutusData, path = ""): PlutusAddress {
  const [payment, stake] = readFields(data, path, 0, 2);
  return {
    paymentCredential: credentialFromData(payment!, at(path, "paymentCredential")),
    stakeCredential: readOption(stake!, at(path, "stakeCredential"), stakeCredentialFromData),
  };
}

export function encodePlutusAddress(value: PlutusAddress): string {
  return codec("encodePlutusAddress", () => encodePlutusDataHex(plutusAddressToData(value)));
}

export function decodePlutusAddress(hex: string): PlutusAddress {
  return codec("decodePlutusAddress", () => plutusAddressFromData(decodeHexData(hex)));
}

// ─── bech32 (CIP-19) ─────────────────────────────────────────────────

const BECH32_LIMIT = 1023;

function prefixFor(networkId: NetworkId): string {
  return networkId === 1 ? "addr" : "addr_test";
}

function readVarNat(bytes: Uint8Array, offset: number): { value: bigint; next: number } {
  let value = 0n;
  for (let i = offset; i < bytes.length; i++) {
    const byte = bytes[i]!;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) return { value, next: i + 1 };
  }
  throw new Error("pointer address ends inside a variable-length number");
}

function writeVarNat(value: bigint, label: string): number[] {
  if (value < 0n) throw new Error(`${label} must not be negative`);
  const out = [Number(value & 0x7fn)];
  for (let rest = value >> 7n; rest > 0n; rest >>= 7n) out.unshift(Number(rest & 0x7fn) | 0x80);
  return out;
}

/** Plutus Address of a bech32 Shelley payment address (`addr` or `addr_test`). */
export function plutusAddressFromBech32(address: string): PlutusAddress {
  return codec("plutusAddressFromBech32", () => {
    const decoded = bech32.decode(address, BECH32_LIMIT);
    const bytes = Uint8Array.from(bech32.fromWords(decoded.words));
    if (bytes.length === 0) throw new Error("empty address");
    const kind = bytes[0]! >> 4;
    const networkId = bytes[0]! & 0x0f;
    if (kind > 7) throw new Error(`address type ${kind} has no Plutus Address form`);
    if ((networkId !== 0 && networkId !== 1) || decoded.prefix !== prefixFor(networkId)) {
      throw new Error(`prefix ${decoded.prefix} does not match network id ${networkId}`);
    }
    const hash = (offset: number) => bytesToHex(bytes.subarray(offset, offset + HASH_BYTES));
    const payment: PlutusCredential = { type: kind % 2 === 0 ? "VerificationKey" : "Script", hash: hash(1) };
    if (kind <= 3) {
      if (bytes.length !== 1 + 2 * HASH_BYTES) throw new Error(`base address must have ${1 + 2 * HASH_BYTES} bytes`);
      const stake: PlutusCredential = { type: kind < 2 ? "VerificationKey" : "Script", hash: hash(1 + HASH_BYTES) };
      return { paymentCredential: payment, stakeCredential: { type: "Inline", credential: stake } };
    }
    if (kind >= 6) {
      if (bytes.length !== 1 + HASH_BYTES) throw new Error(`enterprise address must have ${1 + HASH_BYTES} bytes`);
      return { paymentCredential: payment, stakeCredential: null };
    }
    if (bytes.length < 1 + HASH_BYTES + 3) throw new Error("pointer address is too short");
    const slot = readVarNat(bytes, 1 + HASH_BYTES);
    const tx = readVarNat(bytes, slot.next);
    const cert = readVarNat(bytes, tx.next);
    if (cert.next !== bytes.length) throw new Error("pointer address has trailing bytes");
    return {
      paymentCredential: payment,
      stakeCredential: { type: "Pointer", slotNumber: slot.value, transactionIndex: tx.value, certificateIndex: cert.value },
    };
  });
}

/** bech32 Shelley payment address of a Plutus Address. */
export function plutusAddressToBech32(address: PlutusAddress, networkId: NetworkId): string {
  return codec("plutusAddressToBech32", () => {
    if (networkId !== 0 && networkId !== 1) throw new Error("network id must be 0 or 1");
    plutusAddressToData(address); // validates the shape and the hash lengths
    const payment = address.paymentCredential;
    const stake = address.stakeCredential;
    const paymentScript = payment.type === "Script" ? 1 : 0;
    let kind: number;
    let tail: number[] = [];
    if (stake === null) {
      kind = 6 + paymentScript;
    } else if (stake.type === "Inline") {
      kind = (stake.credential.type === "Script" ? 2 : 0) + paymentScript;
      tail = Array.from(hexToBytes(stake.credential.hash));
    } else {
      kind = 4 + paymentScript;
      tail = [
        ...writeVarNat(stake.slotNumber, "slotNumber"),
        ...writeVarNat(stake.transactionIndex, "transactionIndex"),
        ...writeVarNat(stake.certificateIndex, "certificateIndex"),
      ];
    }
    const bytes = Uint8Array.from([(kind << 4) | networkId, ...hexToBytes(payment.hash), ...tail]);
    return bech32.encode(prefixFor(networkId), bech32.toWords(bytes), BECH32_LIMIT);
  });
}
