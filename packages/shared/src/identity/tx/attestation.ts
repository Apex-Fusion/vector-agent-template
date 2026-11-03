/**
 * Transaction builders of the attestation contract (Part 2 §4.1): Attest,
 * RevokeAtt, Contest, and Withdraw with Burn. The rules follow
 * `contracts/identity-marketplace/lib/identity_marketplace/attestation/handlers.ak`.
 */

import type { Utxo } from "../../chain/ChainProvider.js";
import {
  attestationDatumToData, attestationMintToData, attestationSpendToData, decodeAttestationDatum,
  type Anchor, type AttestationDatum,
} from "../../cbor/Attestation.js";
import {
  ANCHOR_URI_MAX_BYTES, DAYS_366_MS, DAYS_90_MS, LOCATOR_MAX_BYTES, MAX_LINKS, MAX_RECORD_INT, MAX_TIME_MS,
  MIN_ATTESTATION_LOVELACE, PURPOSE_ASSERTION,
} from "../constants.js";
import { keyHash, vectorIdFromSeed } from "../id.js";
import { completeTx } from "./complete.js";
import { coinForOutput, enterpriseAddress, isEnterpriseAddressOf, paymentCredential, utxoAssets, type TxOutput } from "./ledger.js";
import { activeKey, ancestorChain, datumMap, effectiveStatus, readRecord, recordMap, type RecordUtxo } from "./records.js";
import { refuse, type ScriptSource, type TxContext, type UnsignedTx, type ValidityWindow } from "./types.js";

export interface AttestationScripts {
  /** The applied attestation validator: its hash is the policy ID; AA is its enterprise address. */
  attestation: ScriptSource;
  /** The identity policy (the `identity_hash` parameter): records are read with it. */
  identityHash: string;
}

/** The fields of a new attestation that the issuer chooses (Part 2 §4). Byte fields are hex. */
export interface AttestationContent {
  /** 0 identity, 1 provenance, 2 software, 3 environment, 4 principal binding, 5 approval, 15 other. */
  attType: number;
  /** CoAP Content-Format of the document (0..65535), or null. */
  format: number | null;
  /** 32 bytes, or null. */
  profile: string | null;
  /** 32 bytes: SHA-256 of the document (a salted commitment for types 4 and 5). */
  digest: string;
  /** Up to 256 bytes, or null. */
  locator: string | null;
  /** 64-byte COSE_Sign1 signature (§4.2), or null. */
  envelopeSig: string | null;
  validFrom: number | null;
  /** At or after issued_at (= hi) and at most 366 days after it; required for types 2 and 3. */
  validUntil: number | null;
  /** The subject's controller co-signs. */
  solicited: boolean;
  links: AttestationDatum["links"];
}

const bytes = (hex: string): number => hex.length / 2;
const validTime = (t: number): boolean => Number.isSafeInteger(t) && t >= 0 && t <= MAX_TIME_MS;

/** The content rules of a new attestation (`valid_content`); the reasons, empty when valid. */
export function attestationProblems(datum: AttestationDatum): string[] {
  const problems: string[] = [];
  const check = (ok: boolean, message: string): void => {
    if (!ok) problems.push(message);
  };
  check(bytes(datum.subject) === 32, "subject has 32 bytes");
  check(bytes(datum.issuer) === 32, "issuer is a 32-byte Ed25519 key");
  check(datum.issuerId === null || bytes(datum.issuerId) === 32, "issuer_id has 32 bytes");
  check((datum.attType >= 0 && datum.attType <= 5) || datum.attType === 15, `att_type ${datum.attType} is reserved (0..5 or 15)`);
  check(datum.format === null || (Number.isSafeInteger(datum.format) && datum.format >= 0 && datum.format <= 65_535), "format is a CoAP Content-Format (0..65535)");
  check(datum.profile === null || bytes(datum.profile) === 32, "profile has 32 bytes");
  check(bytes(datum.digest) === 32, "digest has 32 bytes");
  check(datum.locator === null || bytes(datum.locator) <= LOCATOR_MAX_BYTES, `locator has at most ${LOCATOR_MAX_BYTES} bytes`);
  check(datum.envelopeSig === null || bytes(datum.envelopeSig) === 64, "envelope_sig has 64 bytes");
  check(validTime(datum.issuedAt), "issued_at is not a valid time");
  if (datum.validUntil === null) {
    check(datum.attType !== 2 && datum.attType !== 3, "types 2 and 3 require valid_until");
    check(datum.validFrom === null || validTime(datum.validFrom), "valid_from is not a valid time");
  } else {
    check(datum.validUntil >= datum.issuedAt && datum.validUntil <= datum.issuedAt + DAYS_366_MS && validTime(datum.validUntil),
      "valid_until is at or after issued_at and at most 366 days after it");
    check(datum.validFrom === null || (validTime(datum.validFrom) && datum.validFrom <= datum.validUntil), "valid_from is at or before valid_until");
  }
  check(datum.links.length <= MAX_LINKS, `at most ${MAX_LINKS} links`);
  datum.links.forEach((link, i) => {
    check(link.rel >= 0 && link.rel <= 3, `links[${i}]: rel is 0..3`);
    check(bytes(link.target) === 32, `links[${i}]: target has 32 bytes`);
  });
  return problems;
}

/** A spent attestation: authentic (exactly at AA, exactly one token of the policy) with its datum. */
interface AttestationUtxo {
  utxo: Utxo;
  id: string;
  datum: AttestationDatum;
}

function readAttestation(scripts: AttestationScripts, utxo: Utxo): AttestationUtxo {
  const where = `attestation ${utxo.ref.txHash}#${utxo.ref.index}`;
  const policy = scripts.attestation.hash;
  if (!isEnterpriseAddressOf(utxo.address, { type: "Script", hash: policy })) refuse("attestation_not_authentic", `${where} is not at the attestation address`);
  const tokens = utxoAssets(utxo).filter((a) => a.policy === policy);
  if (tokens.length !== 1 || tokens[0]!.quantity !== 1n) refuse("attestation_not_authentic", `${where} does not hold exactly one attestation token`);
  if (utxo.datumHex === null) refuse("attestation_not_authentic", `${where} has no inline datum`);
  return { utxo, id: tokens[0]!.name, datum: decodeAttestationDatum(utxo.datumHex) };
}

/** Who acts for the issuer of a registered issuer (issuer_id set): the listed issuer key, or the issuer record's controller. */
export type IssuerAuthority = "issuer" | "controller";

/**
 * Issuer authority (§4.1): with `issuer_id = None` the issuer key signs. With
 * `issuer_id = Some(i)` the record of `i` is a reference input, and its
 * controller signs, or the issuer key signs while the record still lists it
 * with the assertion purpose.
 */
function issuerAuthority(
  scripts: AttestationScripts,
  datum: AttestationDatum,
  issuerRecord: Utxo | undefined,
  authority: IssuerAuthority | undefined,
): { signer: string; reference: Utxo | null } {
  if (datum.issuerId === null) {
    if (authority === "controller") refuse("issuer_unregistered", "the issuer has no record; only the issuer key acts");
    return { signer: keyHash(datum.issuer), reference: null };
  }
  if (issuerRecord === undefined) refuse("issuer_record_missing", `the issuer record ${datum.issuerId} must be a reference input`);
  const record = readRecord(issuerRecord, scripts.identityHash, "issuer record");
  if (record.id !== datum.issuerId) refuse("issuer_record_mismatch", `the issuer record is ${record.id}, not ${datum.issuerId}`);
  const listed = activeKey(record.datum, keyHash(datum.issuer), PURPOSE_ASSERTION);
  const chosen = authority ?? (listed ? "issuer" : "controller");
  if (chosen === "issuer" && !listed) refuse("issuer_key_removed", "the issuer record no longer lists the issuer key; its controller must act");
  return { signer: chosen === "issuer" ? keyHash(datum.issuer) : keyHash(record.datum.controller), reference: record.utxo };
}

function attestationOutput(ctx: TxContext, scripts: AttestationScripts, id: string, datum: AttestationDatum, floor: bigint): TxOutput {
  const shape = {
    address: enterpriseAddress({ type: "Script", hash: scripts.attestation.hash }, ctx.networkId),
    assets: [{ policy: scripts.attestation.hash, name: id, quantity: 1n }],
    datum: attestationDatumToData(datum),
    scriptRef: null,
  };
  return { ...shape, coin: coinForOutput(shape, ctx.protocol.coinsPerUtxoByte, floor) };
}

export interface AttestArgs {
  /** The UTxO that the transaction spends (key-locked); the token name is `blake2b_256(serialise(seed))`. */
  seed: Utxo;
  window: ValidityWindow;
  /** The subject's record (live or tombstone), a reference input. */
  subject: Utxo;
  /** The issuer's Ed25519 public key (32 bytes, hex). It signs. */
  issuer: string;
  /** For a registered issuer: its record (effective status Active, lists the issuer key with the assertion purpose) and its ancestors. */
  issuerRecord?: { record: Utxo; ancestors?: Utxo[] };
  content: AttestationContent;
  /** The attestation output's AP3X (default and minimum 5 AP3X). */
  deposit?: bigint;
}

export interface AttestTx extends UnsignedTx {
  /** The attestation token name (64 hex characters). */
  attestationId: string;
  attestationOutput: number;
}

/** Attest { seed }: mints the attestation token to AA with a new attestation datum. */
export function buildAttest(ctx: TxContext, scripts: AttestationScripts, args: AttestArgs): AttestTx {
  const { lo, hi } = args.window;
  if (paymentCredential(args.seed.address)?.type !== "VerificationKey") refuse("seed_not_key_locked", "the seed must be a key-locked UTxO");
  const id = vectorIdFromSeed(args.seed.ref.txHash, args.seed.ref.index);
  const subject = readRecord(args.subject, scripts.identityHash, "subject record");
  const references: Utxo[] = [subject.utxo];
  const signers = new Set<string>([keyHash(args.issuer)]);
  let issuerId: string | null = null;
  if (args.issuerRecord !== undefined) {
    const issuer = readRecord(args.issuerRecord.record, scripts.identityHash, "issuer record");
    const ancestors = (args.issuerRecord.ancestors ?? []).map((u, i) => readRecord(u, scripts.identityHash, `issuer ancestor ${i}`));
    const chain = ancestorChain(issuer.datum, recordMap(ancestors));
    const status = effectiveStatus(issuer.datum, datumMap(chain), lo, hi);
    if (status !== "Active") refuse("issuer_not_active", `the issuer's effective status is ${status}`);
    if (!activeKey(issuer.datum, keyHash(args.issuer), PURPOSE_ASSERTION)) {
      refuse("issuer_key_not_listed", "the issuer record does not list the issuer key with the assertion purpose");
    }
    issuerId = issuer.id;
    references.push(issuer.utxo, ...chain.map((r: RecordUtxo) => r.utxo));
  }
  if (args.content.solicited) signers.add(keyHash(subject.datum.controller));
  const datum: AttestationDatum = {
    subject: subject.id,
    issuer: args.issuer,
    issuerId,
    ...args.content,
    issuedAt: hi,
    status: { type: "AttActive" },
    contested: null,
  };
  const problems = attestationProblems(datum);
  if (problems.length > 0) refuse("attestation_invalid", `the attestation is not valid: ${problems.join("; ")}`);
  const deposit = args.deposit ?? MIN_ATTESTATION_LOVELACE;
  if (deposit < MIN_ATTESTATION_LOVELACE) refuse("deposit_too_low", `an attestation holds at least ${MIN_ATTESTATION_LOVELACE} base units`);
  const tx = completeTx(ctx, {
    inputs: [{ utxo: args.seed }],
    referenceInputs: references,
    outputs: [attestationOutput(ctx, scripts, id, datum, deposit)],
    mints: [{
      policy: scripts.attestation.hash,
      assets: [{ name: id, quantity: 1n }],
      redeemer: { data: attestationMintToData({ type: "Attest", seed: args.seed.ref }), label: "attestation Attest" },
      script: scripts.attestation,
    }],
    withdrawals: [],
    extraSignatories: [...signers],
    window: args.window,
  });
  return { ...tx, attestationId: id, attestationOutput: 0 };
}

/** RevokeAtt { reason }: AttActive becomes AttRevoked { at: lo, reason }; issuer authority. */
export function buildRevokeAtt(
  ctx: TxContext,
  scripts: AttestationScripts,
  args: { attestation: Utxo; window: ValidityWindow; reason: number; issuerRecord?: Utxo; authority?: IssuerAuthority },
): UnsignedTx {
  const spent = readAttestation(scripts, args.attestation);
  if (spent.datum.status.type !== "AttActive") refuse("attestation_revoked", "the attestation is already revoked");
  if (!Number.isSafeInteger(args.reason) || args.reason < 0 || BigInt(args.reason) > MAX_RECORD_INT) refuse("reason_invalid", "reason must be in [0, 2^63)");
  const authority = issuerAuthority(scripts, spent.datum, args.issuerRecord, args.authority);
  const next: AttestationDatum = { ...spent.datum, status: { type: "AttRevoked", at: args.window.lo, reason: args.reason } };
  return completeTx(ctx, {
    inputs: [{
      utxo: spent.utxo,
      redeemer: { data: attestationSpendToData({ type: "RevokeAtt", reason: args.reason }), label: "attestation RevokeAtt" },
      script: scripts.attestation,
    }],
    referenceInputs: authority.reference === null ? [] : [authority.reference],
    outputs: [attestationOutput(ctx, scripts, spent.id, next, spent.utxo.lovelace)],
    mints: [],
    withdrawals: [],
    extraSignatories: [authority.signer],
    window: args.window,
  });
}

/** Contest: the subject's controller sets `contested` to an anchor (uri 1..256 bytes, sha256 32 bytes). */
export function buildContest(
  ctx: TxContext,
  scripts: AttestationScripts,
  args: { attestation: Utxo; window: ValidityWindow; subject: Utxo; anchor: Anchor },
): UnsignedTx {
  const spent = readAttestation(scripts, args.attestation);
  const subject = readRecord(args.subject, scripts.identityHash, "subject record");
  if (subject.id !== spent.datum.subject) refuse("subject_mismatch", `the subject record is ${subject.id}, not ${spent.datum.subject}`);
  if (bytes(args.anchor.uri) < 1 || bytes(args.anchor.uri) > ANCHOR_URI_MAX_BYTES || bytes(args.anchor.sha256) !== 32) {
    refuse("anchor_invalid", `an anchor has a uri of 1..${ANCHOR_URI_MAX_BYTES} bytes and a 32-byte sha256`);
  }
  const next: AttestationDatum = { ...spent.datum, contested: args.anchor };
  return completeTx(ctx, {
    inputs: [{ utxo: spent.utxo, redeemer: { data: attestationSpendToData({ type: "Contest" }), label: "attestation Contest" }, script: scripts.attestation }],
    referenceInputs: [subject.utxo],
    outputs: [attestationOutput(ctx, scripts, spent.id, next, spent.utxo.lovelace)],
    mints: [],
    withdrawals: [],
    extraSignatories: [keyHash(subject.datum.controller)],
    window: args.window,
  });
}

/**
 * Withdraw with Burn: after `at + 90 days ≤ lo` (revoked) or
 * `valid_until + 90 days ≤ lo`, the issuer burns the token and takes the deposit.
 */
export function buildWithdrawAttestation(
  ctx: TxContext,
  scripts: AttestationScripts,
  args: { attestation: Utxo; window: ValidityWindow; issuerRecord?: Utxo; authority?: IssuerAuthority },
): UnsignedTx {
  const spent = readAttestation(scripts, args.attestation);
  const { lo } = args.window;
  const status = spent.datum.status;
  const revokedLongAgo = status.type === "AttRevoked" && status.at + DAYS_90_MS <= lo;
  const expiredLongAgo = spent.datum.validUntil !== null && spent.datum.validUntil + DAYS_90_MS <= lo;
  if (!revokedLongAgo && !expiredLongAgo) {
    refuse("attestation_not_withdrawable", "an attestation can be withdrawn 90 days after its revocation or after valid_until");
  }
  const authority = issuerAuthority(scripts, spent.datum, args.issuerRecord, args.authority);
  return completeTx(ctx, {
    inputs: [{ utxo: spent.utxo, redeemer: { data: attestationSpendToData({ type: "Withdraw" }), label: "attestation Withdraw" }, script: scripts.attestation }],
    referenceInputs: authority.reference === null ? [] : [authority.reference],
    outputs: [],
    mints: [{
      policy: scripts.attestation.hash,
      assets: [{ name: spent.id, quantity: -1n }],
      redeemer: { data: attestationMintToData({ type: "Burn" }), label: "attestation Burn" },
      script: scripts.attestation,
    }],
    withdrawals: [],
    extraSignatories: [authority.signer],
    window: args.window,
  });
}
