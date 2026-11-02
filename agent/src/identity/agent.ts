/**
 * supplier/src/identity/agent.ts — the supplier's agent in the identity
 * registry (Part 2 §6.1–§6.3, §9.2, §9.6).
 *
 * During the drain the supplier reads and spends both escrow and advert
 * layouts. A new (16-field) escrow names the agent that may work it
 * (`agent_id`). The supplier works a new escrow only for its own agent: the
 * AGENT_ID setting, or else the agent of its configured new advert. Claim and
 * Submit of a new escrow read the agent's record (a reference input that the
 * shared builders check as the escrow contract does), and the receipt of a
 * new escrow carries `agent_did` (9 fields). A legacy escrow keeps the legacy
 * paths and the 8-field receipt.
 */

import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import {
  decodeAdvertDatum,
  decodeAnyAdvertDatum,
  decodeAnyEscrowDatum,
  decodeEscrowDatum,
  type AdvertDatum,
  type AnyAdvertDatum,
  type AnyEscrowDatum,
  type EscrowDatum,
  type IdentityAdvertDatum,
  type IdentityEscrowDatum,
} from "@marketplace/shared/cbor";
import { isVectorId, vectorDid } from "@marketplace/shared/identity";
import {
  agentWorkProblem,
  ESCROW_INPUT_CAP_LOVELACE,
  ESCROW_VALUE_CAP_LOVELACE,
  isIdentityAdvertDatum,
  isIdentityEscrowDatum,
  loadIdentityBlueprint,
  readAgentRecord,
  TxConstructionError,
  type IdentityBlueprint,
  type RecordLookup,
} from "@marketplace/shared/tx";

/** An HTTP refusal: status, machine reason and message. */
export interface Refusal {
  status: number;
  reason: string;
  message: string;
}

/**
 * What the supplier needs for a new escrow: the record lookup of Claim and
 * Submit, and the identity blueprint (new escrow and advert scripts).
 */
export interface SupplierIdentity {
  lookupRecord: RecordLookup;
  /** Throws when the identity hash is not configured (env IDENTITY_POLICY_ID). */
  blueprint(): IdentityBlueprint;
}

/** AGENT_ID: 64 lowercase hex characters, or undefined when unset. */
export function parseAgentId(value: string | undefined, name = "AGENT_ID"): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (!isVectorId(value)) throw new Error(`${name} must be 64 lowercase hex characters (an agent identifier)`);
  return value;
}

/** Either escrow layout. A datum that the strict decoder refuses is read by the legacy decoder, as the shared builders do. */
export function decodeEscrow(hex: string): AnyEscrowDatum {
  try {
    return decodeAnyEscrowDatum(hex);
  } catch {
    return { layout: "legacy", datum: decodeEscrowDatum(hex) };
  }
}

/** Either advert layout, with the same legacy fallback as decodeEscrow. */
export function decodeAdvert(hex: string): AnyAdvertDatum {
  try {
    return decodeAnyAdvertDatum(hex);
  } catch {
    return { layout: "legacy", datum: decodeAdvertDatum(hex) };
  }
}

/**
 * The supplier's own agent: AGENT_ID, else the agent of the configured new
 * advert, else null (legacy only). Throws when AGENT_ID and the advert name
 * different agents.
 */
export function ownAgentId(configured: string | undefined, advert: AdvertDatum | IdentityAdvertDatum): string | null {
  const advertAgent = isIdentityAdvertDatum(advert) ? advert.agent_id : null;
  if (configured !== undefined && advertAgent !== null && configured !== advertAgent) {
    throw new Error(`AGENT_ID ${configured} differs from the configured advert's agent_id ${advertAgent}`);
  }
  return configured ?? advertAgent;
}

/**
 * Why the supplier must not Claim `escrow` (held at `escrowLovelace`), or
 * null. A legacy escrow passes. A new escrow must name the supplier's own
 * agent, stay within the value cap (§6.1, §6.5 F-29), and the identity
 * blueprint must be configured.
 */
export function newEscrowRefusal(
  escrow: EscrowDatum | IdentityEscrowDatum,
  escrowLovelace: bigint,
  agentId: string | null,
  identity: SupplierIdentity,
): Refusal | null {
  if (!isIdentityEscrowDatum(escrow)) return null;
  if (agentId === null) {
    return { status: 503, reason: "agent_not_configured",
      message: "this supplier has no agent (set AGENT_ID or configure a new advert); it cannot work a new escrow" };
  }
  if (escrow.agent_id !== agentId) {
    return { status: 403, reason: "wrong_agent",
      message: `escrow agent_id ${escrow.agent_id} is not this supplier's agent ${agentId}` };
  }
  const total = escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace;
  if (escrow.payment_lovelace < 0n || escrow.buyer_bond_lovelace < 0n || escrow.supplier_bond_lovelace < 0n ||
      total > ESCROW_VALUE_CAP_LOVELACE || escrowLovelace > ESCROW_INPUT_CAP_LOVELACE) {
    return { status: 409, reason: "escrow_not_claimable",
      message: `escrow amounts (payment + bonds = ${total}, held ${escrowLovelace}) are outside the value cap` };
  }
  try {
    identity.blueprint();
  } catch (err) {
    return { status: 503, reason: "identity_not_configured", message: (err as Error).message };
  }
  return null;
}

/** The identity options of Claim and Submit: the record lookup, and the blueprint for a new escrow. */
export function identityOptions(
  escrow: EscrowDatum | IdentityEscrowDatum,
  identity: SupplierIdentity | undefined,
): { lookupRecord?: RecordLookup; identityBlueprint?: IdentityBlueprint } {
  if (identity === undefined) return {};
  return isIdentityEscrowDatum(escrow)
    ? { lookupRecord: identity.lookupRecord, identityBlueprint: identity.blueprint() }
    : { lookupRecord: identity.lookupRecord };
}

/** The receipt field of a new escrow: agent_did = "did:vector:<agent_id>" (§6.3). A legacy escrow has none. */
export function receiptAgentDid(escrow: EscrowDatum | IdentityEscrowDatum): { agent_did?: string } {
  return isIdentityEscrowDatum(escrow) ? { agent_did: vectorDid(escrow.agent_id) } : {};
}

/** Builder refusals of a §6.1 record check: the agent cannot work. */
const AGENT_REFUSALS: Record<string, true> = {
  "agent record lookup required": true, "agent record not found": true, "agent record not authentic": true,
  "agent not independent": true, "agent not active": true, "supplier key not listed": true, "capability not listed": true,
};
/** Builder refusals of the escrow itself: no Claim can succeed. */
const ESCROW_REFUSALS: Record<string, true> = {
  "escrow above value cap": true, "escrow input above cap": true, "negative escrow amount": true,
  "escrow layout mismatch": true,
};

/**
 * A Claim or Submit builder refusal that is not a wallet or chain failure: the
 * agent cannot work (its record fails a §6.1 check), or the new escrow cannot
 * be claimed. Null for any other error.
 */
export function identityRefusal(err: unknown): Refusal | null {
  if (!(err instanceof TxConstructionError)) return null;
  if (AGENT_REFUSALS[err.reason] === true) return { status: 503, reason: "agent_not_eligible", message: err.message };
  if (ESCROW_REFUSALS[err.reason] === true) return { status: 409, reason: "escrow_not_claimable", message: err.message };
  return null;
}

/** True when `utxo` holds the identity token `<identityHash><agentId>`. Ogmios units are "policy.name". */
function holdsToken(utxo: Utxo, unit: string): boolean {
  return Object.entries(utxo.assets).some(([key, quantity]) => key.toLowerCase().replace(".", "") === unit && quantity > 0n);
}

/**
 * A record lookup over the chain: the output at the identity address that
 * holds the agent's token. It keeps the last output reference per agent and
 * reads that output first; a record update spends it, and then the lookup
 * scans the identity address again. The builders check the output they get
 * (find_record), so this lookup only finds it.
 */
export function chainRecordLookup(
  chain: ChainProvider,
  networkId: 0 | 1,
  blueprint: () => IdentityBlueprint,
): RecordLookup {
  const last = new Map<string, OutputReference>();
  return async (agentId) => {
    const identity = blueprint();
    const unit = `${identity.identityHash}${agentId}`;
    const known = last.get(agentId);
    if (known !== undefined) {
      const utxo = await chain.queryUtxo(known);
      if (utxo !== null && holdsToken(utxo, unit)) return utxo;
      last.delete(agentId);
    }
    const found = (await chain.queryUtxosByAddress(identity.identityScriptAddress(networkId)))
      .find((utxo) => holdsToken(utxo, unit)) ?? null;
    if (found !== null) last.set(agentId, found.ref);
    return found;
  };
}

/**
 * The supplier identity over the chain. `blueprint` is the identity blueprint
 * (default: loadIdentityBlueprint(), env IDENTITY_POLICY_ID, read on first use
 * so that a legacy-only supplier needs no identity setting).
 */
export function supplierIdentity(
  chain: ChainProvider,
  networkId: 0 | 1,
  options: { blueprint?: IdentityBlueprint; lookupRecord?: RecordLookup } = {},
): SupplierIdentity {
  const blueprint = (): IdentityBlueprint => options.blueprint ?? loadIdentityBlueprint();
  return { blueprint, lookupRecord: options.lookupRecord ?? chainRecordLookup(chain, networkId, blueprint) };
}

/**
 * The listing rule's record checks (§6.2) for an advert of `keyHash` and
 * `capabilityId` under `agentId` at `atMs`: an authentic record, independent,
 * effectively Active, that lists the key with the transaction purpose and the
 * capability. Returns the failed rule, or null. The creating transaction's
 * signature by the supplier key is the advert builder's part.
 */
export async function advertRecordProblem(
  identity: SupplierIdentity,
  agentId: string,
  keyHash: string,
  capabilityId: string,
  atMs: number,
): Promise<string | null> {
  try {
    const record = readAgentRecord(await identity.lookupRecord(agentId), identity.blueprint().identityHash, agentId);
    return agentWorkProblem(record, { keyHash, capabilityId, lo: atMs, hi: atMs });
  } catch (err) {
    if (err instanceof TxConstructionError) return err.reason;
    throw err;
  }
}
