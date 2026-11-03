// Transaction builders of the identity registry, the configuration seal, attestations,
// delegations and vaults (Part 2 §3–§5, §9.1, §10). Pure and browser-safe: each
// builder returns an unsigned transaction, the key hashes that must sign it and the
// reference inputs that it reads.

export type {
  BuiltRedeemer, ExUnits, ProtocolParameters, RedeemerTag, ScriptSource, SlotConfig, TxContext, TxOutput, UnsignedTx,
  ValidityWindow,
} from "./types.js";
export { TxConstructionError, VECTOR_MAINNET_SLOT_CONFIG } from "./types.js";
export { checkWindow, slotAt, validityWindow } from "./complete.js";
export {
  addressBytes, addressFromBytes, enterpriseAddress, executionFee, minUtxo, paymentCredential, plutusV3Hash,
  referenceScriptFee, scriptDataHash,
} from "./ledger.js";
export type { Credential, TxAsset, VKeyWitness } from "./ledger.js";
export {
  activeKey, CONFIG_TOKEN_NAME, datumProblems, effectiveStatus, readConfigRecord, readRecord,
} from "./records.js";
export type { EffectiveStatus, RecordUtxo } from "./records.js";
export {
  buildAdopt, buildBumpEpoch, buildChangeController, buildReclaim, buildRecoverCancel, buildRecoverFinalize,
  buildRecoverInit, buildRegister, buildRetire, buildRevoke, buildSetSuccessor, buildSuspend, buildUnsuspend,
  buildUpdate, ed25519Key, LEGACY_CHANGE_MIN, legacyProfile, p256Key, RECORD_DEPOSIT, REVOKE_REASONS, SUSPEND_REASONS,
} from "./identity.js";
export type {
  AdoptArgs, AdoptionScripts, CreatedRecordTx, IdentityScripts, NewRecord, Profile, RegisterArgs, RevokeArgs,
  SuspendArgs, UpdateArgs,
} from "./identity.js";
export { buildConfigSeal } from "./config.js";
export type { ConfigSealArgs, ConfigSealTx } from "./config.js";
export {
  attestationProblems, buildAttest, buildContest, buildRevokeAtt, buildWithdrawAttestation,
} from "./attestation.js";
export type { AttestArgs, AttestationContent, AttestationScripts, AttestTx, IssuerAuthority } from "./attestation.js";
export {
  buildDelegate, buildUndelegate, delegationProblems, delegationUse, escrowResource, HIRE_ACTION, narrower,
  patternCovers, readDelegation, validActionPattern, validResourcePattern,
} from "./delegation.js";
export type { DelegateArgs, DelegateTx, DelegationScripts, DelegationUtxo, UndelegateArgs } from "./delegation.js";
export { buildVaultClose, buildVaultOpen, buildVaultPay } from "./vault.js";
export type { VaultEscrowJob, VaultPayArgs, VaultScripts } from "./vault.js";
export { compressP256, createP256Pop, decompressP256, p256PopMessage, verifyP256Pop } from "./pop.js";
export { addVKeyWitnesses, signTransaction, transactionId } from "./witness.js";
