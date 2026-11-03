/**
 * Conway ledger encoding for the identity transaction builders: addresses
 * (CIP-19), values, outputs, the transaction body and witness set, the
 * script data hash and the minimum fee.
 *
 * Sources (current official specifications):
 * - Conway CDDL, cardano-ledger `eras/conway/impl/cddl-files/conway.cddl`
 *   (https://github.com/IntersectMBO/cardano-ledger/blob/master/eras/conway/impl/cddl-files/conway.cddl):
 *   transaction body keys, sets as tag 258, post-Alonzo outputs, redeemers as a map.
 * - CIP-19 addresses (https://cips.cardano.org/cip/CIP-0019): header nibbles, bech32 prefixes.
 * - Script integrity hash and language views: Alonzo ledger specification §4 and the
 *   Babbage/Conway `getLanguageView` (PlutusV2 and later: the language as an unsigned
 *   integer and the cost model as a definite list).
 * - Minimum fee: `getMinFeeTx` of the Conway ledger: size fee + `txscriptfee` (ceiling of
 *   the execution-unit prices) + `tierRefScriptFee` (stride 25,600 bytes, multiplier 1.2).
 * - Minimum UTxO: Babbage `getMinCoinTxOut`: (160 + serialised output size) × coinsPerUTxOByte.
 *
 * Browser-safe: no Node.js API.
 */

import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import type { OutputReference, Utxo } from "../../chain/ChainProvider.js";
import { bytesToHex, decodePlutusDataHex, encodePlutusData, hexToBytes, type PlutusData } from "../../cbor/plutus-data.js";
import type { NetworkId } from "../../network.js";
import {
  CBOR_NULL, CBOR_TRUE, cborArray, cborBytes, cborInt, cborMap, cborSet, cborTag, cborUint, concatBytes,
} from "./cbor.js";

// ─── Hashes and hex ──────────────────────────────────────────────────

export const blake2b224Hex = (bytes: Uint8Array): string => bytesToHex(blake2b(bytes, { dkLen: 28 }));
export const blake2b256Hex = (bytes: Uint8Array): string => bytesToHex(blake2b(bytes, { dkLen: 32 }));

/** Script hash = policy ID of a Plutus V3 script: blake2b_224(0x03 ‖ compiledCode). */
export function plutusV3Hash(compiledCodeHex: string): string {
  return blake2b224Hex(concatBytes([Uint8Array.of(0x03), hexToBytes(compiledCodeHex, "compiledCode")]));
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Lowercase hex strings of even length compare like their bytes. */
export const compareHex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ─── Addresses (CIP-19) ──────────────────────────────────────────────

export type Credential = { type: "VerificationKey"; hash: string } | { type: "Script"; hash: string };

const BECH32_LIMIT = 1023;

/** The raw bytes of a bech32 Shelley address (payment or reward). */
export function addressBytes(address: string): Uint8Array {
  try {
    return Uint8Array.from(bech32.fromWords(bech32.decode(address, BECH32_LIMIT).words));
  } catch (error) {
    throw new Error(`not a bech32 address: ${address} (${error instanceof Error ? error.message : String(error)})`);
  }
}

/** The bech32 form of raw Shelley address bytes (CIP-19 prefixes). */
export function addressFromBytes(bytes: Uint8Array): string {
  const type = bytes[0]! >> 4;
  const mainnet = (bytes[0]! & 0x0f) === 1;
  const reward = type === 0b1110 || type === 0b1111;
  const prefix = reward ? (mainnet ? "stake" : "stake_test") : mainnet ? "addr" : "addr_test";
  return bech32.encode(prefix, bech32.toWords(bytes), BECH32_LIMIT);
}

/** The enterprise address of a credential: the credential as payment part and no stake part. */
export function enterpriseAddress(credential: Credential, networkId: NetworkId): string {
  const type = credential.type === "Script" ? 0b0111 : 0b0110;
  return addressFromBytes(concatBytes([Uint8Array.of((type << 4) | networkId), hexToBytes(credential.hash, "credential hash")]));
}

/** The reward address of a stake credential (withdrawals). */
export function rewardAddressBytes(credential: Credential, networkId: NetworkId): Uint8Array {
  const type = credential.type === "Script" ? 0b1111 : 0b1110;
  return concatBytes([Uint8Array.of((type << 4) | networkId), hexToBytes(credential.hash, "credential hash")]);
}

/** The payment credential of a base, pointer or enterprise address; null for other address types. */
export function paymentCredential(address: string): Credential | null {
  const bytes = addressBytes(address);
  const type = bytes[0]! >> 4;
  if (type > 0b0111 || bytes.length < 29) return null;
  const hash = bytesToHex(bytes.subarray(1, 29));
  return (type & 1) === 1 ? { type: "Script", hash } : { type: "VerificationKey", hash };
}

/** True for an enterprise address of exactly this credential. */
export function isEnterpriseAddressOf(address: string, credential: Credential): boolean {
  const bytes = addressBytes(address);
  const expected = credential.type === "Script" ? 0b0111 : 0b0110;
  return bytes.length === 29 && bytes[0]! >> 4 === expected && bytesToHex(bytes.subarray(1)) === credential.hash;
}

/** The network ID in the header of an address. */
export const addressNetwork = (address: string): number => addressBytes(address)[0]! & 0x0f;

// ─── Values and outputs ──────────────────────────────────────────────

/** A native asset quantity. `policy` 28 bytes and `name` 0..32 bytes, both lowercase hex. */
export interface TxAsset {
  policy: string;
  name: string;
  quantity: bigint;
}

/** A transaction output. `coin` is in base units of AP3X (1 AP3X = 1,000,000). */
export interface TxOutput {
  /** bech32 address. */
  address: string;
  coin: bigint;
  /** Positive quantities. */
  assets: TxAsset[];
  /** The inline datum, or null for none. */
  datum: PlutusData | null;
  /** A Plutus V3 reference script (compiled code hex), or null. */
  scriptRef: string | null;
}

const assetKey = (a: { policy: string; name: string }): string => `${a.policy}.${a.name}`;

/** Merges equal assets, drops zero quantities and sorts by policy, then by name. */
export function normaliseAssets(assets: readonly TxAsset[]): TxAsset[] {
  const merged = new Map<string, TxAsset>();
  for (const asset of assets) {
    const key = assetKey(asset);
    merged.set(key, { policy: asset.policy, name: asset.name, quantity: (merged.get(key)?.quantity ?? 0n) + asset.quantity });
  }
  return [...merged.values()]
    .filter((a) => a.quantity !== 0n)
    .sort((a, b) => compareHex(a.policy, b.policy) || compareHex(a.name, b.name));
}

/** The assets of a chain UTxO (`assets` keys are policy ID hex + asset name hex). */
export function utxoAssets(utxo: Utxo): TxAsset[] {
  return normaliseAssets(Object.entries(utxo.assets).map(([unit, quantity]) => {
    const flat = unit.replace(".", "");
    if (!/^(?:[0-9a-f]{2}){28,60}$/.test(flat)) throw new Error(`bad asset unit ${unit}`);
    return { policy: flat.slice(0, 56), name: flat.slice(56), quantity };
  }));
}

/** A chain UTxO as an output (address, value, inline datum, reference script). */
export function utxoOutput(utxo: Utxo): TxOutput {
  return {
    address: utxo.address,
    coin: utxo.lovelace,
    assets: utxoAssets(utxo),
    datum: utxo.datumHex === null ? null : decodePlutusDataHex(utxo.datumHex),
    scriptRef: utxo.scriptRef,
  };
}

/** The quantity of one asset in a list. */
export function quantityOf(assets: readonly TxAsset[], policy: string, name?: string): bigint {
  let total = 0n;
  for (const a of assets) if (a.policy === policy && (name === undefined || a.name === name)) total += a.quantity;
  return total;
}

/** The ledger multi-asset map (also the mint field): policy → name → quantity. */
function encodeMultiasset(assets: readonly TxAsset[]): Uint8Array {
  const groups: Array<{ policy: string; entries: Array<readonly [Uint8Array, Uint8Array]> }> = [];
  for (const asset of normaliseAssets(assets)) {
    const entry = [cborBytes(hexToBytes(asset.name, "asset name")), cborInt(asset.quantity)] as const;
    const last = groups.at(-1);
    if (last !== undefined && last.policy === asset.policy) last.entries.push(entry);
    else groups.push({ policy: asset.policy, entries: [entry] });
  }
  return cborMap(groups.map(({ policy, entries }) => [cborBytes(hexToBytes(policy, "policy")), cborMap(entries)] as const));
}

function encodeValue(coin: bigint, assets: readonly TxAsset[]): Uint8Array {
  const normal = normaliseAssets(assets);
  if (normal.some((a) => a.quantity < 0n)) throw new Error("an output cannot hold a negative quantity");
  if (normal.length === 0) return cborUint(coin);
  return cborArray([cborUint(coin), encodeMultiasset(normal)]);
}

/** Post-Alonzo output: a map with 0 address, 1 value, 2 datum option and 3 reference script. */
export function encodeOutput(output: TxOutput): Uint8Array {
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cborUint(0), cborBytes(addressBytes(output.address))],
    [cborUint(1), encodeValue(output.coin, output.assets)],
  ];
  if (output.datum !== null) {
    entries.push([cborUint(2), cborArray([cborUint(1), cborTag(24, cborBytes(encodePlutusData(output.datum)))])]);
  }
  if (output.scriptRef !== null) {
    const script = cborArray([cborUint(3), cborBytes(hexToBytes(output.scriptRef, "scriptRef"))]);
    entries.push([cborUint(3), cborTag(24, cborBytes(script))]);
  }
  return cborMap(entries);
}

/** Ledger min-UTxO (Babbage and later): (160 + size of the output) × coinsPerUTxOByte. */
export function minUtxo(output: TxOutput, coinsPerUtxoByte: bigint): bigint {
  return (160n + BigInt(encodeOutput(output).length)) * coinsPerUtxoByte;
}

/**
 * The least coin that makes `output` meet the min-UTxO with at least `floor`.
 * The coin's own encoding size counts, so the function repeats until stable.
 */
export function coinForOutput(output: Omit<TxOutput, "coin">, coinsPerUtxoByte: bigint, floor = 0n): bigint {
  let coin = floor;
  for (let i = 0; i < 8; i += 1) {
    const needed = minUtxo({ ...output, coin }, coinsPerUtxoByte);
    if (coin >= needed) return coin;
    coin = needed;
  }
  return coin;
}

// ─── Transaction body and witness set ────────────────────────────────

export interface ExUnits {
  mem: bigint;
  steps: bigint;
}

export type RedeemerTag = "spend" | "mint" | "withdraw";

export interface EncodedRedeemer {
  tag: RedeemerTag;
  /** Spend: position in the sorted inputs. Mint: in the sorted policies. Withdraw: in the sorted reward accounts. */
  index: number;
  data: PlutusData;
  exUnits: ExUnits;
}

const REDEEMER_TAG: Record<RedeemerTag, number> = { spend: 0, mint: 1, withdraw: 3 };

export const compareOutRefs = (a: OutputReference, b: OutputReference): number =>
  compareHex(a.txHash, b.txHash) || a.index - b.index;

/** The ledger order of reward accounts: network, then script before key, then hash. */
export function compareRewardAccounts(a: Uint8Array, b: Uint8Array): number {
  const network = (a[0]! & 0x0f) - (b[0]! & 0x0f);
  if (network !== 0) return network;
  const scriptA = a[0]! >> 4 === 0b1111 ? 0 : 1;
  const scriptB = b[0]! >> 4 === 0b1111 ? 0 : 1;
  return scriptA - scriptB || compareBytes(a.subarray(1), b.subarray(1));
}

const encodeOutRef = (ref: OutputReference): Uint8Array =>
  cborArray([cborBytes(hexToBytes(ref.txHash, "txHash")), cborUint(ref.index)]);

export interface TxBody {
  /** Sorted. */
  inputs: OutputReference[];
  outputs: TxOutput[];
  fee: bigint;
  /** Slot (invalid_hereafter). */
  ttl: bigint;
  /** Sorted by reward account. */
  withdrawals: Array<{ rewardAccount: Uint8Array; amount: bigint }>;
  /** Slot (invalid_before). */
  validityStart: bigint;
  /** Positive and negative quantities. */
  mint: TxAsset[];
  scriptDataHash: string | null;
  /** Sorted. */
  collateral: OutputReference[];
  /** Sorted key hashes. */
  requiredSigners: string[];
  collateralReturn: TxOutput | null;
  totalCollateral: bigint | null;
  /** Sorted. */
  referenceInputs: OutputReference[];
}

export function encodeBody(body: TxBody): Uint8Array {
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [
    [cborUint(0), cborSet(body.inputs.map(encodeOutRef))],
    [cborUint(1), cborArray(body.outputs.map(encodeOutput))],
    [cborUint(2), cborUint(body.fee)],
    [cborUint(3), cborUint(body.ttl)],
  ];
  if (body.withdrawals.length > 0) {
    entries.push([cborUint(5), cborMap(body.withdrawals.map((w) => [cborBytes(w.rewardAccount), cborUint(w.amount)] as const))]);
  }
  entries.push([cborUint(8), cborUint(body.validityStart)]);
  if (body.mint.length > 0) entries.push([cborUint(9), encodeMultiasset(body.mint)]);
  if (body.scriptDataHash !== null) entries.push([cborUint(11), cborBytes(hexToBytes(body.scriptDataHash, "scriptDataHash"))]);
  if (body.collateral.length > 0) entries.push([cborUint(13), cborSet(body.collateral.map(encodeOutRef))]);
  if (body.requiredSigners.length > 0) {
    entries.push([cborUint(14), cborSet(body.requiredSigners.map((h) => cborBytes(hexToBytes(h, "required signer"))))]);
  }
  if (body.collateralReturn !== null) entries.push([cborUint(16), encodeOutput(body.collateralReturn)]);
  if (body.totalCollateral !== null) entries.push([cborUint(17), cborUint(body.totalCollateral)]);
  if (body.referenceInputs.length > 0) entries.push([cborUint(18), cborSet(body.referenceInputs.map(encodeOutRef))]);
  return cborMap(entries);
}

/** The redeemers of the witness set: the Conway map form `{ [tag, index] => [data, ex_units] }`. */
export function encodeRedeemers(redeemers: readonly EncodedRedeemer[]): Uint8Array {
  return cborMap(redeemers.map((r) => [
    cborArray([cborUint(REDEEMER_TAG[r.tag]), cborUint(r.index)]),
    cborArray([encodePlutusData(r.data), cborArray([cborUint(r.exUnits.mem), cborUint(r.exUnits.steps)])]),
  ] as const));
}

export interface VKeyWitness {
  /** 32-byte Ed25519 public key, hex. */
  vkey: string;
  /** 64-byte signature of the transaction ID, hex. */
  signature: string;
}

export function encodeVKeyWitness(w: VKeyWitness): Uint8Array {
  return cborArray([cborBytes(hexToBytes(w.vkey, "vkey")), cborBytes(hexToBytes(w.signature, "signature"))]);
}

/** The witness set: 0 key witnesses, 5 redeemers, 7 Plutus V3 scripts. */
export function encodeWitnessSet(args: {
  vkeys: readonly VKeyWitness[];
  redeemers: Uint8Array | null;
  scripts: readonly string[];
}): Uint8Array {
  const entries: Array<readonly [Uint8Array, Uint8Array]> = [];
  if (args.vkeys.length > 0) entries.push([cborUint(0), cborSet(args.vkeys.map(encodeVKeyWitness))]);
  if (args.redeemers !== null) entries.push([cborUint(5), args.redeemers]);
  if (args.scripts.length > 0) entries.push([cborUint(7), cborSet(args.scripts.map((s) => cborBytes(hexToBytes(s, "script"))))]);
  return cborMap(entries);
}

/** A complete transaction: body, witness set, valid, no auxiliary data. */
export const encodeTransaction = (body: Uint8Array, witnessSet: Uint8Array): Uint8Array =>
  cborArray([body, witnessSet, CBOR_TRUE, CBOR_NULL]);

// ─── Script data hash ────────────────────────────────────────────────

/**
 * The script integrity hash for a transaction that runs only Plutus V3
 * scripts and has no witness datums: blake2b_256(redeemers ‖ language views),
 * with the language view `{ 2: [cost model] }` (PlutusV3 is language 2).
 */
export function scriptDataHash(redeemers: Uint8Array, costModelV3: readonly number[]): string {
  const views = cborMap([[cborUint(2), cborArray(costModelV3.map((c) => cborInt(BigInt(c))))]]);
  return blake2b256Hex(concatBytes([redeemers, views]));
}

// ─── Fees ────────────────────────────────────────────────────────────

/** An exact rational from a JS number written in decimal or exponent form. */
export function toRational(value: number): { num: bigint; den: bigint } {
  if (!Number.isFinite(value) || value < 0) throw new Error(`bad price or fee parameter ${value}`);
  const [mantissa, exponentPart] = value.toString().toLowerCase().split("e");
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart);
  const [whole, fraction = ""] = mantissa!.split(".");
  let num = BigInt(`${whole}${fraction}`);
  let den = 10n ** BigInt(fraction.length);
  if (exponent >= 0) num *= 10n ** BigInt(exponent);
  else den *= 10n ** BigInt(-exponent);
  return { num, den };
}

const ceilDiv = (num: bigint, den: bigint): bigint => (num + den - 1n) / den;

/** `txscriptfee`: ceiling(priceMem × mem + priceStep × steps), over the sum of all redeemers. */
export function executionFee(priceMem: number, priceStep: number, units: ExUnits): bigint {
  const m = toRational(priceMem);
  const s = toRational(priceStep);
  return ceilDiv(units.mem * m.num * s.den + units.steps * s.num * m.den, m.den * s.den);
}

/** Conway `tierRefScriptFee`: stride 25,600 bytes, price × 1.2 per stride, floor of the total. */
export function referenceScriptFee(costPerByte: number, totalSize: number): bigint {
  if (totalSize <= 0 || costPerByte === 0) return 0n;
  const base = toRational(costPerByte);
  // Exact rational sum: acc = accNum / accDen, price = priceNum / priceDen.
  let accNum = 0n;
  let accDen = 1n;
  let priceNum = base.num;
  let priceDen = base.den;
  let rest = BigInt(totalSize);
  const stride = 25_600n;
  for (;;) {
    const size = rest < stride ? rest : stride;
    // acc += size × price
    accNum = accNum * priceDen + size * priceNum * accDen;
    accDen *= priceDen;
    if (rest < stride) return accNum / accDen;
    rest -= stride;
    priceNum *= 6n;
    priceDen *= 5n;
  }
}

/** Every key witness adds [vkey, signature]: 1 + (2 + 32) + (2 + 64) bytes. */
export const VKEY_WITNESS_BYTES = 101;

export { bytesToHex, hexToBytes };
