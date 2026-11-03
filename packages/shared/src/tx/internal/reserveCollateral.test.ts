import { describe, it, expect } from "vitest";
import { reserveCollateralInputs, reserveScriptSpendCollateral } from "./liveCbor.js";

// Minimal LucidUTxO-shaped fixtures (the helpers only read txHash/outputIndex/assets/scriptRef).
const pure = (id: string, lovelace: bigint) =>
  ({ txHash: id, outputIndex: 0, assets: { lovelace } }) as never;
const mixed = (id: string, lovelace: bigint) =>
  ({ txHash: id, outputIndex: 0, assets: { lovelace, "policy.tok": 1n } }) as never;

const LOCKED = 2_200_000n; // price + buyer_bond + supplier_bond
const ids = (r: ReturnType<typeof reserveCollateralInputs>) =>
  (r ?? []).map((u: { txHash: string }) => u.txHash);

describe("reserveCollateralInputs", () => {
  it("reserves a 5-ADA collateral UTxO and funds from the rest", () => {
    const r = reserveCollateralInputs([pure("collat", 5_000_000n), pure("work", 6_000_000n)], LOCKED);
    expect(ids(r)).toEqual(["work"]); // collat (smallest ≥5) reserved
  });

  it("reserves the SMALLEST qualifying candidate", () => {
    const r = reserveCollateralInputs([pure("big", 9_000_000n), pure("small", 5_000_000n)], LOCKED);
    expect(ids(r)).toEqual(["big"]); // small reserved as collateral
  });

  it("only reserves PURE-ADA UTxOs (ignores ones carrying native assets)", () => {
    const r = reserveCollateralInputs([mixed("mixed", 10_000_000n), pure("purecol", 6_000_000n)], LOCKED);
    expect(ids(r)).toEqual(["mixed"]); // purecol reserved, fund from the mixed UTxO
  });

  it("returns null for a single UTxO (large change stays as collateral under default selection)", () => {
    expect(reserveCollateralInputs([pure("only", 12_000_000n)], LOCKED)).toBeNull();
  });

  it("returns null when no UTxO qualifies as collateral", () => {
    expect(reserveCollateralInputs([pure("a", 4_000_000n), pure("b", 4_000_000n)], LOCKED)).toBeNull();
  });

  it("returns null when reserving collateral would underfund the escrow", () => {
    // {5 collateral, 3 working}: working can't cover locked + cushion → fall back.
    expect(reserveCollateralInputs([pure("collat", 5_000_000n), pure("work", 3_000_000n)], LOCKED)).toBeNull();
  });
});

const AP3X = 1_000_000n;
const withScriptRef = (id: string, lovelace: bigint) =>
  ({ txHash: id, outputIndex: 0, assets: { lovelace }, scriptRef: { type: "PlutusV3", script: "00" } }) as never;

describe("reserveScriptSpendCollateral", () => {
  it("keeps the 5 AP3X collateral UTxO out and spends the large working UTxO", () => {
    const r = reserveScriptSpendCollateral([pure("collat", 5n * AP3X), pure("work", 186n * AP3X)]);
    expect(ids(r)).toEqual(["work"]);
  });

  it("lets three 2 AP3X UTxOs carry the collateral when the 5 AP3X UTxO is reserved", () => {
    const small = Array.from({ length: 10 }, (_, i) => pure(`small${i}`, 2n * AP3X));
    const r = reserveScriptSpendCollateral([pure("collat", 5n * AP3X), ...small]);
    expect(ids(r)).toEqual(small.map((_, i) => `small${i}`));
  });

  it("returns null when the rest cannot provide collateral", () => {
    expect(reserveScriptSpendCollateral([pure("collat", 5n * AP3X), pure("work", 2n * AP3X)])).toBeNull();
  });

  it("returns null when the three largest leave the collateral return below its min-UTxO", () => {
    // 2 + 2 + 1.999999 covers the 5 AP3X collateral, but lucid would need a 4th input
    // to fund the ~0.97 AP3X collateral return output.
    const r = reserveScriptSpendCollateral([
      pure("collat", 5n * AP3X), pure("a", 2n * AP3X), pure("b", 2n * AP3X), pure("c", 2n * AP3X - 1n),
    ]);
    expect(r).toBeNull();
  });

  it("returns null for a lone collateral UTxO", () => {
    expect(reserveScriptSpendCollateral([pure("collat", 5n * AP3X)])).toBeNull();
  });

  it("returns null when no UTxO qualifies as collateral", () => {
    expect(reserveScriptSpendCollateral([pure("a", 4n * AP3X), pure("b", 4n * AP3X)])).toBeNull();
  });

  it("reserves the SMALLEST qualifying candidate", () => {
    const r = reserveScriptSpendCollateral([pure("nine", 9n * AP3X), pure("five", 5n * AP3X), pure("six", 6n * AP3X)]);
    expect(ids(r)).toEqual(["nine", "six"]);
  });

  it("never reserves a token-bearing or script-ref UTxO", () => {
    const r = reserveScriptSpendCollateral([
      mixed("mixed", 5n * AP3X), withScriptRef("ref", 6n * AP3X), pure("nine", 9n * AP3X), pure("work", 186n * AP3X),
    ]);
    expect(ids(r)).toEqual(["mixed", "ref", "work"]); // nine reserved
  });

  it("returns null when lucid would take a token-bearing UTxO as collateral", () => {
    // lucid picks largest first, tokens or not; the return output of a token pick is not modelled.
    const r = reserveScriptSpendCollateral([
      pure("collat", 5n * AP3X), mixed("mixed", 4n * AP3X), pure("a", 2n * AP3X), pure("b", 2n * AP3X),
    ]);
    expect(r).toBeNull();
  });

  it("keeps token-bearing UTxOs that lucid does not need for collateral", () => {
    const r = reserveScriptSpendCollateral([pure("collat", 5n * AP3X), pure("work", 186n * AP3X), mixed("mixed", 2n * AP3X)]);
    expect(ids(r)).toEqual(["work", "mixed"]);
  });

  it("requires the rest to fund the outputs that the escrow input does not cover", () => {
    const wallet = [pure("collat", 5n * AP3X), pure("work", 6n * AP3X)];
    // 6 AP3X = 0.5 fee floor + 2 change floor + 3.5 shortfall.
    expect(ids(reserveScriptSpendCollateral(wallet, 3_500_000n))).toEqual(["work"]);
    expect(reserveScriptSpendCollateral(wallet, 3_500_001n)).toBeNull();
  });

  it("does not count an escrow surplus toward the fee", () => {
    const wallet = [pure("collat", 5n * AP3X), pure("work", 2n * AP3X)];
    expect(reserveScriptSpendCollateral(wallet, -10n * AP3X)).toBeNull();
  });
});
