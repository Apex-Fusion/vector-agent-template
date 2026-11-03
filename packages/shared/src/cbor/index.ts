// Barrel export for CBOR codecs.
// Legacy marketplace layouts (cbor-x encoding, unchanged).
export type { AdvertDatum, EscrowDatum, EscrowState, AdvertStatus, POSIXTime, VerificationKeyHash } from "./types.js";
export { encodeAdvertDatum, decodeAdvertDatum } from "./AdvertDatum.js";
export { encodeEscrowDatum, decodeEscrowDatum } from "./EscrowDatum.js";
export { canonicalize } from "./canonical.js";

// Canonical Plutus Data (byte-equal to Plutus serialiseData and Aiken cbor.serialise).
export type { PlutusData } from "./plutus-data.js";
export { encodePlutusData, decodePlutusData, encodePlutusDataHex, decodePlutusDataHex } from "./plutus-data.js";
export type { PlutusAddress, PlutusCredential, PlutusStakeCredential } from "./address.js";
export {
  plutusAddressToData, plutusAddressFromData, encodePlutusAddress, decodePlutusAddress,
  plutusAddressFromBech32, plutusAddressToBech32,
} from "./address.js";

// Identity registry record and legacy registry record (Part 1 §5).
export type {
  IdentityDatum, Key, KeyType, Signer, Role, Party, Lineage, Status, Hold, PendingRecovery, LegacyDatum,
} from "./IdentityDatum.js";
export {
  KEY_TYPES, ROLES,
  encodeIdentityDatum, decodeIdentityDatum, identityDatumToData, identityDatumFromData,
  encodeLegacyDatum, decodeLegacyDatum, legacyDatumToData, legacyDatumFromData,
} from "./IdentityDatum.js";

// Identity contract redeemers (Part 2 §3.1).
export type { IdentityMint, Actor, IdentitySpend } from "./IdentityRedeemer.js";
export { encodeIdentityMint, decodeIdentityMint, encodeIdentitySpend, decodeIdentitySpend } from "./IdentityRedeemer.js";

// Attestations (Part 2 §4).
export type { AttestationDatum, AttStatus, Anchor, Link, AttestationMint, AttestationSpend } from "./Attestation.js";
export {
  encodeAttestationDatum, decodeAttestationDatum, attestationDatumToData, attestationDatumFromData,
  encodeAttestationMint, decodeAttestationMint, encodeAttestationSpend, decodeAttestationSpend,
} from "./Attestation.js";

// Delegations and vaults (Part 2 §5.2, §5.3).
export type { Delegator, ValueLimit, DelegationDatum, DelegationMint, VaultDatum, VaultSpend } from "./Delegation.js";
export {
  encodeDelegationDatum, decodeDelegationDatum, delegationDatumToData, delegationDatumFromData,
  encodeDelegationMint, decodeDelegationMint,
  encodeVaultDatum, decodeVaultDatum, vaultDatumToData, vaultDatumFromData, encodeVaultSpend, decodeVaultSpend,
} from "./Delegation.js";

// New escrow and advert layouts (Part 2 §6.1, §6.2).
export type { IdentityEscrowDatum, Refund, EscrowRedeemer, AnyEscrowDatum } from "./IdentityEscrowDatum.js";
export {
  encodeIdentityEscrowDatum, decodeIdentityEscrowDatum, identityEscrowDatumToData, identityEscrowDatumFromData,
  decodeAnyEscrowDatum, encodeEscrowRedeemer, decodeEscrowRedeemer,
} from "./IdentityEscrowDatum.js";
export type { IdentityAdvertDatum, AdvertRedeemer, AnyAdvertDatum } from "./IdentityAdvertDatum.js";
export {
  encodeIdentityAdvertDatum, decodeIdentityAdvertDatum, identityAdvertDatumToData, identityAdvertDatumFromData,
  decodeAnyAdvertDatum, encodeAdvertRedeemer, decodeAdvertRedeemer,
} from "./IdentityAdvertDatum.js";
