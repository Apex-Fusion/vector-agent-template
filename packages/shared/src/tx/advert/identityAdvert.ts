/**
 * tx/advert/identityAdvert.ts — the identity-layout branches of the advert
 * builders: the new advert (Part 2 §6.2) with `agent_id` as field 13.
 *
 * The contract rules stay as for the legacy advert, and UpdateAdvert keeps
 * agent_id. The contract does not check identity; the builders check the
 * listing rule of §6.2 for the advert they write, so that a posted or updated
 * advert is listed: the record of agent_id is authentic, independent and
 * effectively Active now, and lists supplier_pkh (transaction purpose) and
 * capability_id. The supplier key signs every advert transaction, which is
 * the first condition of the listing rule.
 */

import type { ChainProvider, Utxo } from "../../chain/ChainProvider.js";
import {
  encodeAdvertRedeemer, encodeIdentityAdvertDatum, type AdvertRedeemer, type IdentityAdvertDatum,
} from "../../cbor/IdentityAdvertDatum.js";
import { loadIdentityBlueprint, type IdentityBlueprint } from "../blueprint.js";
import { assertAgentCanWork, readAgentRecord, type RecordLookup } from "../identityRecord.js";
import type { BuildResult, WalletKey } from "../types.js";
import { TxConstructionError } from "../types.js";
import { detectCborBackend } from "../internal/cborBackend.js";
import { MIN_UTXO_LOVELACE, mockSlotToWallclockMs } from "../internal/constants.js";
import { submitSpend, type SpendPlan } from "../internal/identitySpend.js";
import { paidToScript } from "../internal/layout.js";
import { pkhToEnterpriseAddress } from "../internal/pkhAddress.js";
import { MOCK_SLOT_CLOCK, nowWindow, vectorSlotClock } from "../internal/window.js";

export interface IdentityAdvertAt {
  utxo: Utxo;
  datum: IdentityAdvertDatum;
}

/** The listing rule (§6.2) for `datum` at `atMs`. Throws TxConstructionError. */
export async function assertAdvertAgentListed(
  lookupRecord: RecordLookup | undefined,
  blueprint: IdentityBlueprint,
  datum: IdentityAdvertDatum,
  atMs: number,
): Promise<void> {
  if (lookupRecord === undefined) {
    throw new TxConstructionError("agent record lookup required", "a new advert needs lookupRecord");
  }
  const record = readAgentRecord(await lookupRecord(datum.agent_id), blueprint.identityHash, datum.agent_id);
  assertAgentCanWork(record, datum.agent_id, {
    keyHash: datum.supplier_pkh,
    capabilityId: datum.capability_id,
    lo: atMs,
    hi: atMs,
  });
}

/** The blueprint, after checking that the advert sits at the new advert script. */
function blueprintFor(advert: IdentityAdvertAt, given: IdentityBlueprint | undefined): IdentityBlueprint {
  const blueprint = given ?? loadIdentityBlueprint();
  if (!paidToScript(advert.utxo.address, blueprint.advertScriptHash)) {
    throw new TxConstructionError(
      "advert layout mismatch",
      `${advert.utxo.ref.txHash}#${advert.utxo.ref.index}: a 14-field advert datum must be at the new advert script ${blueprint.advertScriptHash}`,
    );
  }
  return blueprint;
}

async function tipTime(chain: ChainProvider): Promise<{ tipMs: number; live: boolean }> {
  const tipSlot = await chain.tip();
  const live = detectCborBackend(chain) === "live";
  return { tipMs: live ? Date.now() : mockSlotToWallclockMs(tipSlot), live };
}

function advertSpend(
  blueprint: IdentityBlueprint,
  value: AdvertRedeemer,
): Pick<SpendPlan, "script" | "redeemer"> {
  return {
    script: {
      compiledCode: blueprint.advertCompiledCode,
      hash: blueprint.advertScriptHash,
      address: (networkId) => blueprint.advertScriptAddress(networkId),
      refEnvKey: "IDENTITY_ADVERT_REF_UTXO",
    },
    redeemer: { name: value.type, hex: encodeAdvertRedeemer(value) },
  };
}

export async function updateIdentityAdvert(args: {
  chain: ChainProvider;
  walletKey: WalletKey;
  advert: IdentityAdvertAt;
  newAdvertDatum: IdentityAdvertDatum;
  deposit_lovelace: bigint;
  lookupRecord?: RecordLookup;
  identityBlueprint?: IdentityBlueprint;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
}): Promise<BuildResult> {
  const { chain, walletKey, advert, newAdvertDatum } = args;
  const oldDatum = advert.datum;
  const blueprint = blueprintFor(advert, args.identityBlueprint);
  if (walletKey.pubKeyHash !== oldDatum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `wallet pkh ${walletKey.pubKeyHash} does not match oldDatum.supplier_pkh ${oldDatum.supplier_pkh}`,
    );
  }
  if (newAdvertDatum.supplier_pkh !== oldDatum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier pkh changed",
      `newDatum.supplier_pkh ${newAdvertDatum.supplier_pkh} differs from old ${oldDatum.supplier_pkh}`,
    );
  }
  if (newAdvertDatum.advertised_at < oldDatum.advertised_at) {
    throw new TxConstructionError(
      "advertised_at regress",
      `new ${newAdvertDatum.advertised_at} < old ${oldDatum.advertised_at}`,
    );
  }
  if (newAdvertDatum.agent_id !== oldDatum.agent_id) {
    throw new TxConstructionError(
      "agent_id changed",
      `new agent_id ${newAdvertDatum.agent_id} differs from old ${oldDatum.agent_id}`,
    );
  }
  const { tipMs, live } = await tipTime(chain);
  await assertAdvertAgentListed(args.lookupRecord, blueprint, newAdvertDatum, tipMs);
  return submitSpend(chain, {
    action: "update-advert",
    ...advertSpend(blueprint, { type: "UpdateAdvert" }),
    walletKey,
    input: advert.utxo,
    referenceInputs: [],
    outputs: [{
      address: (networkId) => blueprint.advertScriptAddress(networkId),
      lovelace: args.deposit_lovelace,
      datumHex: encodeIdentityAdvertDatum(newAdvertDatum),
    }],
    requiredSigners: [oldDatum.supplier_pkh],
    window: nowWindow(tipMs, live ? vectorSlotClock() : MOCK_SLOT_CLOCK),
    reserveCollateral: false,
    beforeSubmit: args.beforeSubmit,
  });
}

export async function retireIdentityAdvert(args: {
  chain: ChainProvider;
  walletKey: WalletKey;
  advert: IdentityAdvertAt;
  identityBlueprint?: IdentityBlueprint;
  beforeSubmit?: (built: BuildResult) => Promise<void>;
}): Promise<BuildResult> {
  const { chain, walletKey, advert } = args;
  const datum = advert.datum;
  const blueprint = blueprintFor(advert, args.identityBlueprint);
  if (walletKey.pubKeyHash !== datum.supplier_pkh) {
    throw new TxConstructionError(
      "supplier signature mismatch",
      `wallet pkh ${walletKey.pubKeyHash} does not match datum.supplier_pkh ${datum.supplier_pkh}`,
    );
  }
  const { tipMs, live } = await tipTime(chain);
  // The validator needs the supplier's signature and an output to its key; the deposit goes back there.
  return submitSpend(chain, {
    action: "retire-advert",
    ...advertSpend(blueprint, { type: "RetireAdvert" }),
    walletKey,
    input: advert.utxo,
    referenceInputs: [],
    outputs: [{
      address: (networkId) => pkhToEnterpriseAddress(datum.supplier_pkh, networkId),
      lovelace: advert.utxo.lovelace < MIN_UTXO_LOVELACE ? MIN_UTXO_LOVELACE : advert.utxo.lovelace,
    }],
    requiredSigners: [datum.supplier_pkh],
    window: nowWindow(tipMs, live ? vectorSlotClock() : MOCK_SLOT_CLOCK),
    reserveCollateral: false,
    beforeSubmit: args.beforeSubmit,
  });
}

