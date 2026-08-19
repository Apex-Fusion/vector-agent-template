/**
 * try-it/src/buy-once.funds.test.ts — the wallet pre-flight, pinned.
 *
 * Written against a real loss. On the first mainnet run of this harness the
 * escrow posted, the job ran, Submit landed, and Accept failed with
 * `collateral_required: wallet has no UTxO >= 5000000` — PostEscrow's coin
 * selection had consumed the buyer's pure-5-ADA UTxO. The money was locked with
 * the accept window running, and the only remaining path was the supplier's
 * Release taking payment and both bonds.
 *
 * `checkSettlementFunds` is the gate that must catch that shape BEFORE the
 * escrow post. Eligibility mirrors the vendored builders exactly
 * (`liveCbor.ts`: >= 5 ADA and nothing but lovelace), and the working-balance
 * threshold mirrors `reserveCollateralInputs` (`locked + 2 ADA`), because below
 * it lucid stops honouring the reserved input set and the collateral becomes
 * spendable — the precise mechanism of the mainnet failure.
 *
 * Chain reads are faked as plain UTxO shapes, like the wire tests fake datums;
 * `@marketplace/shared/tx` is mocked wholesale (lucid/CML WASM).
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@marketplace/shared/tx", () => ({
  buildPostEscrowTx: vi.fn(),
  buildAcceptTx: vi.fn(),
}));

import {
  checkSettlementFunds,
  COLLATERAL_MIN_LOVELACE,
  WORKING_BALANCE_CUSHION_LOVELACE,
  type WalletUtxoLike,
} from "./buy-once.js";

/** A typical job: 1 AP3X payment + 1 each side in bonds. */
const LOCK = 3_000_000n;

function pure(lovelace: bigint): WalletUtxoLike {
  return { lovelace, assets: {} };
}

function withToken(lovelace: bigint): WalletUtxoLike {
  return { lovelace, assets: { "d0e7…beef.4d59544f4b454e": 1n } };
}

describe("checkSettlementFunds", () => {
  it("passes the shape the fix asks operators to fund: 5 ADA collateral + a spending UTxO", () => {
    const utxos = [pure(COLLATERAL_MIN_LOVELACE), pure(LOCK + WORKING_BALANCE_CUSHION_LOVELACE)];
    expect(checkSettlementFunds(utxos, LOCK)).toEqual({ ok: true });
  });

  it("refuses when no UTxO can serve as Accept collateral", () => {
    // Plenty of money, wrong shape: one big UTxO, so coin selection takes it
    // and Accept is left with nothing to offer as collateral.
    const utxos = [pure(4_999_999n), pure(4_000_000n)];
    const result = checkSettlementFunds(utxos, LOCK);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("collateral_missing");
    expect(result.message).toContain("no pure-lovelace UTxO >= 5000000");
    expect(result.message).toContain("TWO UTxOs");
  });

  it("does not count a UTxO carrying native assets as collateral", () => {
    // Big enough, but collateral must be pure lovelace (vendored rule).
    const utxos = [withToken(50_000_000n), pure(1_000_000n)];
    const result = checkSettlementFunds(utxos, LOCK);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("collateral_missing");
  });

  it("refuses when funding the escrow would have to spend the collateral", () => {
    // This is the mainnet shape: a valid collateral UTxO exists, but everything
    // else falls short of lock + cushion, so lucid selects freely and eats it.
    const utxos = [pure(COLLATERAL_MIN_LOVELACE), pure(2_000_000n)];
    const result = checkSettlementFunds(utxos, LOCK);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("insufficient_working_balance");
    expect(result.message).toContain("short by 3000000");
    expect(result.message).toContain("TWO UTxOs");
  });

  it("refuses a single fat UTxO — enough ada, unusable shape", () => {
    const result = checkSettlementFunds([pure(100_000_000n)], LOCK);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    // The collateral candidate is the only UTxO, so nothing is left to spend.
    expect(result.reason).toBe("insufficient_working_balance");
  });

  it("refuses an empty wallet with the collateral leg, not a confusing balance error", () => {
    const result = checkSettlementFunds([], LOCK);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("collateral_missing");
  });

  it("reserves the CHEAPEST eligible UTxO, matching reserveCollateralInputs", () => {
    // Two eligible UTxOs: the 5 ADA one is held back, the 9 ADA one is working
    // balance. 9 >= lock(3) + cushion(2), so this passes — it would fail if the
    // check reserved the larger one instead.
    const utxos = [pure(9_000_000n), pure(COLLATERAL_MIN_LOVELACE)];
    expect(checkSettlementFunds(utxos, LOCK)).toEqual({ ok: true });
  });

  it("holds the line exactly at lock + cushion", () => {
    const exact = [pure(COLLATERAL_MIN_LOVELACE), pure(LOCK + WORKING_BALANCE_CUSHION_LOVELACE)];
    const oneShort = [pure(COLLATERAL_MIN_LOVELACE), pure(LOCK + WORKING_BALANCE_CUSHION_LOVELACE - 1n)];

    expect(checkSettlementFunds(exact, LOCK)).toEqual({ ok: true });
    expect(checkSettlementFunds(oneShort, LOCK).ok).toBe(false);
  });
});
