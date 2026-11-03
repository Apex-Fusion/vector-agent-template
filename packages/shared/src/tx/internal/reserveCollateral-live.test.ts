/**
 * Build-level check that Accept and Reclaim leave the buyer's 5 AP3X
 * collateral UTxO untouched when the rest of the wallet can pay. Real lucid
 * builds the tx; only the Ogmios HTTP endpoint is faked.
 */
import { describe, it, expect, vi } from "vitest";
import type { Utxo } from "../../chain/ChainProvider.js";
import { LiveOgmiosProvider } from "../../chain/LiveOgmiosProvider.js";
import { encodeEscrowDatum } from "../../cbor/EscrowDatum.js";
import type { EscrowDatum } from "../../cbor/types.js";
import { inspectSignedTransactionFinancials } from "../server.js";
import type { WalletKey } from "../types.js";
import { buildLiveTxForAccept, buildLiveTxForReclaim } from "./liveCbor.js";

// Deterministic test key: priv = sha256("buyer-test-seed-m1b").
const BUYER: WalletKey = {
  privateKeyHex: "90787d55b2be1ea57e633d5cc85b1dad2e49603bdbc24e40d0928fca8e92f424",
  pubKeyHex: "6e2902cf80ab89e44701470ce41c044a9bbffe3d8af15af2009cc9c6c805271a",
  pubKeyHash: "f79cd20a58306c2277cfced6924befbd0f68c95e2187830d707b20b5",
  address: "addr_test1vrmee5s2tqcxcgnhel8ddyjta77s76xftcsc0qcdwpajpdgjdd5nn",
};

const POSTED_AT = 1_780_000_000_000;
const SUBMITTED_AT = POSTED_AT + 50_000;
const DATUM: EscrowDatum = {
  buyer_pkh: BUYER.pubKeyHash,
  supplier_pkh: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef01",
  advert_ref: { txHash: "b".repeat(64), index: 0 },
  capability_id: "llm.text.generate.v1",
  request_spec_hash: "c".repeat(64),
  prompt_hash: "d".repeat(64),
  payment_lovelace: 2_000_000n,
  buyer_bond_lovelace: 1_000_000n,
  supplier_bond_lovelace: 1_000_000n,
  deliver_by: POSTED_AT + 90_000,
  posted_at: POSTED_AT,
  submitted_at: SUBMITTED_AT,
  result_receipt_hash: "e".repeat(64),
  state: "Submitted",
};
// The buyer output is padded from 1 to 2 AP3X, so the wallet adds 1 AP3X on Accept.
const ESCROW: Utxo = {
  ref: { txHash: "f".repeat(64), index: 2 },
  address: "addr_test1wrqq9qqjzf3uh4w9hm0kqzrpvt60r4ryjp5rjf5epd3nptq7yscm6",
  lovelace: 4_000_000n,
  assets: {},
  datumHex: encodeEscrowDatum(DATUM),
  scriptRef: null,
};

// The 5 AP3X collateral UTxO is the largest one: before the reservation,
// lucid spent it for the fee every time.
const COLLATERAL = { txHash: "a".repeat(64), index: 0 };
const WALLET: Array<[string, number]> = [
  ["a".repeat(64), 5_000_000],
  ["b".repeat(64), 3_000_000],
  ["c".repeat(64), 2_500_000],
  ["d".repeat(64), 2_500_000],
];

function rpcOk(result: unknown) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", result }) };
}

function fakeChain(): LiveOgmiosProvider {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    switch (body.method) {
      case "queryLedgerState/utxo":
        if (body.params?.outputReferences) return rpcOk([]);
        return rpcOk(WALLET.map(([id, lovelace]) => ({
          transaction: { id }, index: 0, address: BUYER.address,
          value: { ada: { lovelace } }, datum: null, datumHash: null, script: null,
        })));
      // One wallet input ("bb…") sorts before the escrow input ("ff…"), so the
      // spend redeemer index is 1, as real Ogmios would report it.
      case "evaluateTransaction":
        return rpcOk([{ validator: { purpose: "spend", index: 1 }, budget: { memory: 1_000_000, cpu: 500_000_000 } }]);
      case "submitTransaction":
        return rpcOk({ transaction: { id: "9".repeat(64) } });
      default:
        return rpcOk({});
    }
  });
  return new LiveOgmiosProvider({ ogmiosUrl: "http://ogmios:1337", fetch: fetch as unknown as typeof globalThis.fetch });
}

describe("buyer script spends keep the collateral UTxO", () => {
  it("Accept pays from the other UTxOs and takes collateral from them", async () => {
    const built = await buildLiveTxForAccept({
      chain: fakeChain(),
      buyerKey: BUYER,
      escrowRef: ESCROW.ref,
      escrowUtxo: ESCROW,
      datum: DATUM,
      tipMs: SUBMITTED_AT + 60_000,
      windowEnd: SUBMITTED_AT + 600_000,
    });

    const tx = inspectSignedTransactionFinancials(built.txCborHex);
    expect(tx.inputs).toContainEqual(ESCROW.ref);
    expect(tx.inputs).not.toContainEqual(COLLATERAL);
    expect(tx.collateralInputs.length).toBeGreaterThan(0);
    expect(tx.collateralInputs).not.toContainEqual(COLLATERAL);
  });

  it("Reclaim pays from the other UTxOs and takes collateral from them", async () => {
    const tipMs = DATUM.deliver_by + 120_000;
    const built = await buildLiveTxForReclaim({
      chain: fakeChain(),
      buyerKey: BUYER,
      escrowRef: ESCROW.ref,
      escrowUtxo: ESCROW,
      datum: DATUM,
      tipMs,
    });

    const tx = inspectSignedTransactionFinancials(built.txCborHex);
    expect(tx.inputs).toContainEqual(ESCROW.ref);
    expect(tx.inputs).not.toContainEqual(COLLATERAL);
    expect(tx.collateralInputs.length).toBeGreaterThan(0);
    expect(tx.collateralInputs).not.toContainEqual(COLLATERAL);
  });
});
