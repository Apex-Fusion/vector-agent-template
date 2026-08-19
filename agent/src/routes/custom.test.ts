/**
 * agent/src/routes/custom.test.ts — route-level pin for the prompt_hash
 * mismatch path in makeCustomHandler.
 *
 * Dependency-light by design (mirrors ../customJobRunner.test.ts): no
 * supertest, no HTTP server. The handler is invoked directly against fake
 * Express req/res objects and a fake ChainProvider whose queryUtxo returns
 * REAL CBOR-encoded advert/escrow datums (built with the same
 * encodeAdvertDatum/encodeEscrowDatum the buyer/supplier use on-chain), so
 * the route's own decode + hash-check logic runs unmodified up to the
 * prompt_hash comparison under test.
 *
 * Pins:
 *   1. a payload whose sha256 does not match the escrow datum's prompt_hash is
 *      rejected 409 prompt_mismatch, BEFORE the supplier slot is acquired
 *      (state.snapshot().activeSessions stays 0) and without falling through
 *      to the Express error handler (next() never called).
 *   2. a live advert whose max_processing_ms is TIGHTER than the configured
 *      ADVERT_MAX_PROCESSING_MS is rejected 503 advert_sla_mismatch pre-Claim,
 *      and a looser one is not (the check is deliberately one-sided).
 *   3. a mount that attached no Executor answers 503 instead of claiming a job
 *      it cannot run.
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";

import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import { encodeAdvertDatum, encodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";

// custom.ts statically imports buildClaimTx/mockSlotToWallclockMs/
// detectCborBackend from "@marketplace/shared/tx" (and, via runCustomJob,
// buildSubmitTx from the same barrel); walletHealth.ts (pulled in for
// triggerOnFailureConsolidate) separately imports runConsolidateWallet from
// "@marketplace/shared/tx/server". Both barrels trace into lucid-evolution/
// CML WASM (and, in this pnpm layout, a broken libsodium-wrappers-sumo
// relative import). The prompt_mismatch path under test never reaches Claim
// or consolidate, so none of these are actually called — mock both modules
// wholesale, same workaround ../customJobRunner.test.ts uses for buildSubmitTx.
vi.mock("@marketplace/shared/tx", () => ({
  buildClaimTx: vi.fn(),
  buildSubmitTx: vi.fn(),
  mockSlotToWallclockMs: vi.fn(),
  detectCborBackend: vi.fn(),
}));
vi.mock("@marketplace/shared/tx/server", () => ({
  runConsolidateWallet: vi.fn(),
}));

import type { SupplierConfig } from "../config.js";
import { SupplierState } from "../state.js";
import { JobStore } from "../jobs.js";
import { makeCustomHandler, type CustomRouteDeps } from "./custom.js";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const ADVERT_REF: OutputReference = { txHash: "e".repeat(64), index: 0 };
const ESCROW_TX_HASH = "c".repeat(64);
const ESCROW_REF_STR = `${ESCROW_TX_HASH}#0`;

const supplierKey: WalletKey = {
  privateKeyHex: "1f".repeat(32),
  pubKeyHex: "2f".repeat(32),
  pubKeyHash: "3f".repeat(28),
  address: "addr_test1_fake",
};

const advert: AdvertDatum = {
  supplier_pkh: supplierKey.pubKeyHash,
  capability_id: "custom.echo.v1",
  model: "echo-service-v1",
  max_output_tokens: 0,
  max_processing_ms: 300_000,
  price_lovelace: 1_000_000n,
  supplier_bond_lovelace: 0n,
  buyer_bond_lovelace: 0n,
  endpoint_url: "https://example.invalid",
  detail_uri: "",
  detail_hash: "00".repeat(32),
  advertised_at: 0,
  status: "Active",
};

const requestSpecHash = sha256Hex(canonicalize({
  capability_id: advert.capability_id,
  max_output_tokens: advert.max_output_tokens,
  model: advert.model,
}));

// prompt_hash is deliberately unrelated to sha256(payload) of the body the
// test below sends — that mismatch is the thing under test.
const escrowDatum: EscrowDatum = {
  buyer_pkh: "4f".repeat(28),
  supplier_pkh: supplierKey.pubKeyHash,
  advert_ref: ADVERT_REF,
  capability_id: advert.capability_id,
  request_spec_hash: requestSpecHash,
  prompt_hash: "ab".repeat(32),
  payment_lovelace: 1_000_000n,
  buyer_bond_lovelace: 0n,
  supplier_bond_lovelace: 0n,
  deliver_by: Date.now() + 300_000,
  posted_at: Date.now(),
  submitted_at: null,
  result_receipt_hash: null,
  state: "Open",
};

function makeChain(
  advertPatch: Partial<AdvertDatum> = {},
  escrowPatch: Partial<EscrowDatum> = {},
): ChainProvider {
  const advertUtxo: Utxo = {
    ref: ADVERT_REF,
    address: "addr_test1_advert",
    lovelace: 0n,
    assets: {},
    datumHex: encodeAdvertDatum({ ...advert, ...advertPatch }),
    scriptRef: null,
  };
  const escrowUtxo: Utxo = {
    ref: { txHash: ESCROW_TX_HASH, index: 0 },
    address: "addr_test1_escrow",
    lovelace: 0n,
    assets: {},
    datumHex: encodeEscrowDatum({ ...escrowDatum, ...escrowPatch }),
    scriptRef: null,
  };
  return {
    tip: vi.fn(async () => 0),
    queryUtxo: vi.fn(async (ref: OutputReference) => {
      if (ref.txHash === ADVERT_REF.txHash) return advertUtxo;
      if (ref.txHash === ESCROW_TX_HASH) return escrowUtxo;
      return null;
    }),
    queryUtxosByAddress: vi.fn(async () => []),
    evaluateTx: vi.fn(async () => ({ ok: true })),
    submitTx: vi.fn(async () => "unused"),
    awaitTx: vi.fn(async () => undefined),
  };
}

function makeReqRes(body: unknown) {
  const captured: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      captured.body = payload;
      return res;
    },
  } as unknown as Response;
  const req = { body } as unknown as Request;
  return { req, res, captured };
}

/** The configured SLA matches the advert above unless a test says otherwise. */
const config = {
  advertRef: ADVERT_REF,
  advertMaxProcessingMs: advert.max_processing_ms,
} as unknown as SupplierConfig;

describe("makeCustomHandler — prompt_hash check", () => {
  it("rejects 409 prompt_mismatch when sha256(payload) does not match the escrow's prompt_hash, without acquiring a slot", async () => {
    const state = new SupplierState(1);
    const deps: CustomRouteDeps = {
      chain: makeChain(),
      state,
      config,
      supplierKey,
      jobs: new JobStore(),
      executor: { execute: vi.fn() },
    };
    const handler = makeCustomHandler(deps);
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({
      escrow_ref: ESCROW_REF_STR,
      payload: "this payload does not hash to the escrow's prompt_hash",
    });

    await handler(req, res, next as unknown as NextFunction);

    expect(captured.statusCode).toBe(409);
    expect(captured.body).toMatchObject({
      reason: "prompt_mismatch",
      error: { reason: "prompt_mismatch" },
    });
    expect(next).not.toHaveBeenCalled();
    // The slot must never be acquired for a request rejected before Claim —
    // confirms the mismatch is caught ahead of any state mutation.
    expect(state.snapshot().activeSessions).toBe(0);
  });
});

describe("makeCustomHandler — advert SLA against the configured one", () => {
  // The boot guard can only check ADVERT_MAX_PROCESSING_MS, the value the
  // operator declared. Only the advert on chain binds: deliver_by comes from
  // its max_processing_ms. An advert tighter than the declared SLA means the
  // node's service budget no longer fits the window, so claiming would burn
  // the bond on a job that lands late.
  function depsWith(
    advertPatch: Partial<AdvertDatum>,
    escrowPatch: Partial<EscrowDatum> = {},
  ): { deps: CustomRouteDeps; state: SupplierState } {
    const state = new SupplierState(1);
    return {
      state,
      deps: {
        chain: makeChain(advertPatch, escrowPatch),
        state,
        config,
        supplierKey,
        jobs: new JobStore(),
        executor: { execute: vi.fn() },
      },
    };
  }

  it("rejects 503 when the live advert's max_processing_ms is tighter than the configured SLA, before any Claim", async () => {
    // A payload whose hash DOES match the escrow, so the only thing left to
    // reject on is the SLA.
    const payload = "matching payload";
    const { deps, state } = depsWith(
      { max_processing_ms: 120_000 },
      { prompt_hash: sha256Hex(payload) },
    );
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({ escrow_ref: ESCROW_REF_STR, payload });

    await makeCustomHandler(deps)(req, res, next as unknown as NextFunction);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ reason: "advert_sla_mismatch" });
    expect((captured.body as { message: string }).message).toContain("120000");
    expect((captured.body as { message: string }).message).toContain("300000");
    expect(next).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("accepts an advert looser than the configured SLA (the node just finishes early)", async () => {
    // Proves the check is one-sided. A looser advert must fall through to the
    // ordinary path; here the escrow's prompt_hash still mismatches, so the
    // request lands on 409 rather than the 503 above.
    const { deps } = depsWith({ max_processing_ms: 600_000 });
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({
      escrow_ref: ESCROW_REF_STR,
      payload: "this payload does not hash to the escrow's prompt_hash",
    });

    await makeCustomHandler(deps)(req, res, next as unknown as NextFunction);

    expect(captured.statusCode).toBe(409);
    expect(captured.body).toMatchObject({ reason: "prompt_mismatch" });
  });
});

describe("makeCustomHandler — executor presence", () => {
  it("rejects 503 rather than claiming a job it has no executor to run", async () => {
    const state = new SupplierState(1);
    const deps: CustomRouteDeps = {
      chain: makeChain(),
      state,
      config,
      supplierKey,
      jobs: new JobStore(),
      // executor deliberately absent: a mount that never attached one
    };
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({ escrow_ref: ESCROW_REF_STR, payload: "anything" });

    await makeCustomHandler(deps)(req, res, next as unknown as NextFunction);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ reason: "executor_unavailable" });
    expect(state.snapshot().activeSessions).toBe(0);
  });
});
