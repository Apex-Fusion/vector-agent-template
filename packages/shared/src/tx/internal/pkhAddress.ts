/**
 * tx/internal/pkhAddress.ts — derive a CIP-0019 enterprise bech32 address
 * from a 28-byte verification-key hash (pkh).
 *
 * Enterprise (no stake credential) layout:
 *   header byte: 0x60 (testnet, type=6 vkh enterprise) | 0x61 (mainnet)
 *   payload:     28-byte vkh
 * HRP: "addr_test" (testnet) | "addr" (mainnet)
 */

import { bech32 } from "bech32";

const VKH_ENTERPRISE_TESTNET_HEADER = 0x60;
const VKH_ENTERPRISE_MAINNET_HEADER = 0x61;
const BECH32_LIMIT = 1023;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`invalid pkh hex (odd length): ${hex.length}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

export function pkhToEnterpriseAddress(pkhHex: string, networkId: 0 | 1 = 0): string {
  const bytes = hexToBytes(pkhHex);
  if (bytes.byteLength !== 28) {
    throw new Error(`pkh must be 28 bytes (56 hex chars), got ${bytes.byteLength}`);
  }
  const header =
    networkId === 0 ? VKH_ENTERPRISE_TESTNET_HEADER : VKH_ENTERPRISE_MAINNET_HEADER;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(bytes, 1);
  const words = bech32.toWords(payload);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  return bech32.encode(hrp, words, BECH32_LIMIT);
}
