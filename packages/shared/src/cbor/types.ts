/**
 * Type declarations for on-chain datum schemas.
 * ARCHITECTURE.md sections 4.1 and 4.2.
 *
 * This file is TYPE-ONLY — no logic. Catherine fills in codecs in M0-C.
 */

import type { OutputReference } from "../chain/ChainProvider.js";

/** POSIX time in milliseconds (Int on-chain). */
export type POSIXTime = number;

/** 28-byte verification key hash, lowercase hex. */
export type VerificationKeyHash = string;

/** AdvertStatus: mirrors Plutus constructor tag 121 (Active) / 122 (Retired). */
export type AdvertStatus = "Active" | "Retired";

/**
 * AdvertDatum — ARCHITECTURE.md §4.1
 *
 * On-chain encoding: Plutus Constr0 (tag 121) with 13 fields in declaration order.
 * ByteArray fields are UTF-8 where stated; VerificationKeyHash is raw bytes (28).
 * detail_hash is raw bytes (32). price_lovelace and bond fields use bigint
 * because they can exceed Number.MAX_SAFE_INTEGER for large AP3X denominations.
 */
export interface AdvertDatum {
  supplier_pkh: VerificationKeyHash;        // 28-byte hex
  capability_id: string;                    // "llm.text.generate.v1"
  model: string;                            // "qwen2.5:0.5b"
  max_output_tokens: number;                // Int
  max_processing_ms: number;                // Int — SLA
  price_lovelace: bigint;                   // AP3X lovelace
  supplier_bond_lovelace: bigint;
  buyer_bond_lovelace: bigint;
  endpoint_url: string;                     // https://...
  detail_uri: string;                       // off-chain JSON pointer
  detail_hash: string;                      // 32-byte hex (sha256)
  advertised_at: POSIXTime;
  status: AdvertStatus;
}

/** EscrowState: mirrors Plutus constructor tags 121–126. */
export type EscrowState =
  | "Open"        // tag 121
  | "Claimed"     // tag 122
  | "Submitted"   // tag 123
  | "Accepted"    // tag 124
  | "Reclaimed"   // tag 125
  | "Released";   // tag 126

/**
 * EscrowDatum — ARCHITECTURE.md §4.2
 *
 * On-chain encoding: Plutus Constr0 (tag 121) with 13 fields in declaration order.
 * advert_ref encodes as Plutus OutputReference = Constr0[txHash:bytes, index:int].
 * submitted_at and result_receipt_hash are Options: null → Constr1 (tag 122, None);
 *   populated → Constr0 (tag 121, [value]) (Some).
 */
export interface EscrowDatum {
  buyer_pkh: VerificationKeyHash;           // 28-byte hex
  supplier_pkh: VerificationKeyHash;        // 28-byte hex
  advert_ref: OutputReference;              // SPEC-LOCK: txHash + index
  capability_id: string;                    // duplicated for indexer filter
  request_spec_hash: string;               // 32-byte hex
  prompt_hash: string;                     // 32-byte hex
  payment_lovelace: bigint;
  buyer_bond_lovelace: bigint;
  supplier_bond_lovelace: bigint;
  deliver_by: POSIXTime;
  posted_at: POSIXTime;
  submitted_at: POSIXTime | null;          // Option<POSIXTime>
  result_receipt_hash: string | null;      // Option<ByteArray(32)>
  state: EscrowState;
}
