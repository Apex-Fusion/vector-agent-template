/**
 * try-it/src/identity.test.ts — the buyer's side of the advert and escrow
 * layouts that carry an agent_id: decoding both layouts, the switch rule, the
 * two listing-rule lookups the vendored Post builder takes, and the lock
 * estimate of the wallet pre-flight.
 */

import { describe, it, expect, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";
import { MockChainProvider, type OutputReference } from "@marketplace/shared/chain";
import {
  encodeAdvertDatum,
  encodeEscrowDatum,
  encodeIdentityAdvertDatum,
  encodeIdentityEscrowDatum,
  type AdvertDatum,
  type EscrowDatum,
} from "@marketplace/shared/cbor";
import { loadIdentityBlueprint } from "@marketplace/shared/tx";

import { chainRecordLookup, decodeAdvert, decodeEscrow, indexerAdvertSigners, postLayout } from "./identity.js";
import { deriveWalletKey, escrowLockLovelace } from "./buy-once.js";

// A stand-in identity hash, not a deployment value: blake2b-224 of a label.
const IDENTITY_HASH = Buffer.from(
  blake2b(new TextEncoder().encode("did:vector test identity registry"), { dkLen: 28 }),
).toString("hex");
const IDENTITY = loadIdentityBlueprint({ identityHash: IDENTITY_HASH });
const AGENT_ID = "a1".repeat(32);
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const BUYER = deriveWalletKey("ab".repeat(32), 1);

const advert: AdvertDatum = {
  supplier_pkh: "5e".repeat(28),
  capability_id: "records.extract.myproduct.v1",
  model: "my-product-v1",
  max_output_tokens: 8192,
  max_processing_ms: 300_000,
  price_lovelace: 200_000n,
  supplier_bond_lovelace: 1_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  endpoint_url: "https://agent.example",
  detail_uri: "",
  detail_hash: "a".repeat(64),
  advertised_at: 0,
  status: "Active",
};

const escrow: EscrowDatum = {
  buyer_pkh: BUYER.pubKeyHash,
  supplier_pkh: advert.supplier_pkh,
  advert_ref: ADVERT_REF,
  capability_id: advert.capability_id,
  request_spec_hash: "c".repeat(64),
  prompt_hash: "d".repeat(64),
  payment_lovelace: 200_000n,
  buyer_bond_lovelace: 1_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  deliver_by: 1_780_000_330_000,
  posted_at: 1_780_000_000_000,
  submitted_at: null,
  result_receipt_hash: null,
  state: "Open",
};

function seedAdvert(chain: MockChainProvider, agentId: string | null): void {
  chain.seed({
    ref: ADVERT_REF,
    address: IDENTITY.advertScriptAddress(0),
    lovelace: 2_000_000n,
    assets: {},
    datumHex: agentId === null ? encodeAdvertDatum(advert) : encodeIdentityAdvertDatum({ ...advert, agent_id: agentId }),
    scriptRef: null,
  });
}

describe("decodeAdvert / decodeEscrow", () => {
  it("reads both layouts and names the agent of the identity layout", () => {
    expect(decodeAdvert(encodeAdvertDatum(advert))).toMatchObject({ layout: "legacy", datum: { model: advert.model } });
    expect(decodeAdvert(encodeIdentityAdvertDatum({ ...advert, agent_id: AGENT_ID })))
      .toMatchObject({ layout: "identity", datum: { agent_id: AGENT_ID } });
    expect(decodeEscrow(encodeEscrowDatum(escrow))).toMatchObject({ layout: "legacy" });
    expect(decodeEscrow(encodeIdentityEscrowDatum({ ...escrow, agent_id: AGENT_ID, refund: null })))
      .toMatchObject({ layout: "identity", datum: { agent_id: AGENT_ID, refund: null } });
  });
});

describe("postLayout", () => {
  it("lets the advert decide before the switch slot and requires the identity layout from it on", () => {
    expect(postLayout(99, null)).toBeUndefined();
    expect(postLayout(99, 100)).toBeUndefined();
    expect(postLayout(100, 100)).toBe("identity");
  });
});

describe("chainRecordLookup", () => {
  it("finds the record output by its token, in either unit spelling", async () => {
    for (const unit of [`${IDENTITY_HASH}${AGENT_ID}`, `${IDENTITY_HASH}.${AGENT_ID}`]) {
      const chain = new MockChainProvider();
      chain.seed({
        ref: { txHash: "7e".repeat(32), index: 0 },
        address: IDENTITY.identityScriptAddress(0),
        lovelace: 10_000_000n,
        assets: { [unit]: 1n },
        datumHex: null,
        scriptRef: null,
      });
      const lookup = chainRecordLookup(chain, IDENTITY, 0);
      expect((await lookup(AGENT_ID))?.ref.txHash).toBe("7e".repeat(32));
      expect(await lookup("b2".repeat(32))).toBeNull();
    }
  });
});

describe("indexerAdvertSigners", () => {
  const row = { utxo_ref: `${ADVERT_REF.txHash}#0`, agent_id: AGENT_ID, supplier_pkh: advert.supplier_pkh };

  it("gives the supplier key when the indexer lists the advert the chain holds", async () => {
    const chain = new MockChainProvider();
    seedAdvert(chain, AGENT_ID);
    const get = vi.fn(async () => [row]);
    expect(await indexerAdvertSigners(chain, "https://indexer.example", get)(ADVERT_REF)).toEqual([advert.supplier_pkh]);
    expect(get).toHaveBeenCalledWith("https://indexer.example/suppliers");
  });

  it("refuses an advert the indexer does not list", async () => {
    const chain = new MockChainProvider();
    seedAdvert(chain, AGENT_ID);
    await expect(indexerAdvertSigners(chain, "https://indexer.example", async () => [])(ADVERT_REF))
      .rejects.toMatchObject({ reason: "advert not listed" });
  });

  it("refuses a listing that names another agent than the advert on chain", async () => {
    const chain = new MockChainProvider();
    seedAdvert(chain, "b2".repeat(32));
    await expect(indexerAdvertSigners(chain, "https://indexer.example", async () => [row])(ADVERT_REF))
      .rejects.toMatchObject({ reason: "advert not listed" });
  });
});

describe("escrowLockLovelace", () => {
  it("locks at least payment + bonds, and more for the larger datum of an escrow with an agent_id", () => {
    const base = { advert, advertRef: ADVERT_REF, buyerKey: BUYER, promptHash: "d".repeat(64), nowMs: 1_780_000_000_000 };
    const legacy = escrowLockLovelace({ ...base, agentId: null });
    const identity = escrowLockLovelace({ ...base, agentId: AGENT_ID });
    expect(legacy).toBeGreaterThanOrEqual(2_200_000n);
    expect(identity).toBeGreaterThan(legacy);
  });
});
