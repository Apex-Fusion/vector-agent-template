import { describe, it, expect } from "vitest";
import { reserveCollateralInputs } from "./liveCbor.js";

// Minimal LucidUTxO-shaped fixtures (the helper only reads txHash/outputIndex/assets).
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
