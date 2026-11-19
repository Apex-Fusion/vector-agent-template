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

import { beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import type { Request, Response, NextFunction } from "express";

import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import { encodeAdvertDatum, encodeEscrowDatum, canonicalize } from "@marketplace/shared/cbor";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import { buildClaimTx, buildSubmitTx, type WalletKey } from "@marketplace/shared/tx";
import type * as TxModule from "@marketplace/shared/tx";

// The paths under test all answer before the Claim, so the two tx builders the
// route can reach (buildClaimTx here, buildSubmitTx via runCustomJob) are
// replaced and must never run. The rest of the barrel stays real: the vendored
// identity helpers the route calls read the escrow layout through it.
// walletHealth.ts (pulled in for triggerOnFailureConsolidate) imports
// runConsolidateWallet from "@marketplace/shared/tx/server"; no consolidate
// may run either, so that module is replaced as well.
vi.mock("@marketplace/shared/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  buildClaimTx: vi.fn(),
  buildSubmitTx: vi.fn(),
}));
vi.mock("@marketplace/shared/tx/server", () => ({
  runConsolidateWallet: vi.fn(),
}));

import type { SupplierConfig } from "../config.js";
import { SupplierState } from "../state.js";
import { JobStore } from "../jobs.js";
import type { SupplierIdentity } from "../identity/agent.js";
import { makeCustomHandler, type CustomRouteDeps } from "./custom.js";
import type { PrecheckJob, PrecheckResult } from "../executor/executor.js";

/**
 * Every escrow in this file has the legacy layout, which needs no agent
 * record. Any read of the identity registry here is a bug, so both members
 * fail loudly. custom.identity.test.ts covers the layout with agent_id.
 */
const legacyOnlyIdentity: SupplierIdentity = {
  lookupRecord: async () => {
    throw new Error("a legacy escrow must not read an agent record");
  },
  blueprint: () => {
    throw new Error("a legacy escrow must not load the identity blueprint");
  },
};

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
  /** The lovelace that the escrow output holds. Default: the payment plus both bonds of its datum. */
  held?: bigint,
): ChainProvider {
  const escrow = { ...escrowDatum, ...escrowPatch };
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
    lovelace: held ?? escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace,
    assets: {},
    datumHex: encodeEscrowDatum(escrow),
    scriptRef: null,
  };
  return {
    tip: vi.fn(async () => 0),
    queryUtxo: vi.fn(async (ref: OutputReference) => {
      if (ref.txHash.toLowerCase() === ADVERT_REF.txHash) return advertUtxo;
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
  serviceTimeoutMs: 120_000,
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
      identity: legacyOnlyIdentity,
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
        identity: legacyOnlyIdentity,
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
      identity: legacyOnlyIdentity,
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

describe("makeCustomHandler — the escrow against the advert of this node", () => {
  // A buyer that builds its own escrow writes any numbers in the datum and locks
  // any amount. The route compares the escrow with the advert of this node
  // before it claims, so a refusal costs no Claim.
  const PAYLOAD = "matching payload";
  const ADVERT_TERMS: Partial<AdvertDatum> = {
    price_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 500_000n,
  };
  /** An escrow that matches ADVERT_TERMS in every term. */
  const MATCHING: Partial<EscrowDatum> = {
    prompt_hash: sha256Hex(PAYLOAD),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 500_000n,
  };
  const SUM = 3_500_000n;

  beforeEach(() => {
    vi.mocked(buildClaimTx).mockReset().mockResolvedValue({ txCborHex: "00", expectedTxHash: "d".repeat(64) });
    vi.mocked(buildSubmitTx).mockReset().mockResolvedValue({ txCborHex: "00", expectedTxHash: "e".repeat(64) });
  });

  interface PostResult {
    captured: { statusCode?: number; body?: unknown };
    state: SupplierState;
  }

  async function post(options: { escrow?: Partial<EscrowDatum>; held?: bigint; config?: SupplierConfig } = {}): Promise<PostResult> {
    const state = new SupplierState(1);
    const deps: CustomRouteDeps = {
      chain: makeChain(ADVERT_TERMS, { ...MATCHING, ...options.escrow }, options.held),
      state,
      config: options.config ?? config,
      supplierKey,
      jobs: new JobStore(),
      identity: legacyOnlyIdentity,
      executor: { execute: vi.fn(async () => ({ outputPayload: "{}" })) },
    };
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({ escrow_ref: ESCROW_REF_STR, payload: PAYLOAD });
    await makeCustomHandler(deps)(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    return { captured, state };
  }

  /** A refusal: the code in `error` and in `reason`, a text, no Claim and no slot held. */
  function expectRefusal(result: PostResult, code: string, text: string) {
    expect(result.captured.statusCode).toBe(409);
    const body = result.captured.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["error", "message", "reason"]);
    expect(body.error).toBe(code);
    expect(body.reason).toBe(code);
    expect(body.message).toContain(text);
    expect(buildClaimTx).not.toHaveBeenCalled();
    expect(result.state.snapshot().activeSessions).toBe(0);
  }

  /** The twin of every refusal: the request passes the checks and the Claim is built. */
  async function expectClaimed(result: PostResult) {
    expect(result.captured.statusCode).toBe(202);
    expect(buildClaimTx).toHaveBeenCalledTimes(1);
    // The job runs on its own: wait until it frees the slot.
    await vi.waitFor(() => expect(result.state.snapshot().activeSessions).toBe(0));
  }

  it("claims an escrow that matches the advert in every term", async () => {
    await expectClaimed(await post());
  });

  it("refuses wrong_advert when the escrow names another advert", async () => {
    const other: OutputReference = { txHash: "f".repeat(64), index: 0 };
    expectRefusal(await post({ escrow: { advert_ref: other } }), "wrong_advert", `${other.txHash}#0`);
  });

  it("refuses wrong_advert when only the output index of the advert differs", async () => {
    expectRefusal(
      await post({ escrow: { advert_ref: { txHash: ADVERT_REF.txHash, index: 1 } } }),
      "wrong_advert",
      `${ADVERT_REF.txHash}#1`,
    );
  });

  it("claims when only the letter case of the configured advert hash differs", async () => {
    const upper = { ...config, advertRef: { txHash: ADVERT_REF.txHash.toUpperCase(), index: ADVERT_REF.index } } as SupplierConfig;
    await expectClaimed(await post({ config: upper }));
  });

  it("refuses underpaid when the payment is below the advert price", async () => {
    expectRefusal(await post({ escrow: { payment_lovelace: 1_999_999n } }), "underpaid", "1999999");
  });

  it("claims when the payment is above the advert price", async () => {
    await expectClaimed(await post({ escrow: { payment_lovelace: 3_000_000n } }));
  });

  it("refuses bond_mismatch when the buyer bond is below the advert bond", async () => {
    expectRefusal(await post({ escrow: { buyer_bond_lovelace: 999_999n } }), "bond_mismatch", "999999");
  });

  it("refuses bond_mismatch when the supplier bond is below the advert bond", async () => {
    expectRefusal(await post({ escrow: { supplier_bond_lovelace: 499_999n } }), "bond_mismatch", "499999");
  });

  it("claims when the buyer bond is above the advert bond (a payment from a vault adds the lock floor to it)", async () => {
    await expectClaimed(await post({ escrow: { buyer_bond_lovelace: 1_500_000n } }));
  });

  it("refuses underpaid when the escrow output holds less than the payment and both bonds", async () => {
    expectRefusal(await post({ held: SUM - 1n }), "underpaid", String(SUM - 1n));
  });

  it("claims when the escrow output holds more than the payment and both bonds (the minimum ada floor)", async () => {
    await expectClaimed(await post({ held: SUM + 1_000_000n }));
  });

  it("names the advert first when the advert and an amount are both wrong", async () => {
    const other: OutputReference = { txHash: "f".repeat(64), index: 0 };
    expectRefusal(
      await post({ escrow: { advert_ref: other, payment_lovelace: 1n } }),
      "wrong_advert",
      `${other.txHash}#0`,
    );
  });
});

describe("makeCustomHandler — the check of the service before the Claim", () => {
  const PAYLOAD = "matching payload";
  // The default escrow and advert match in every term. Only the hash of the payload is set.
  const MATCHING: Partial<EscrowDatum> = { prompt_hash: sha256Hex(PAYLOAD) };
  const REFUSAL: PrecheckResult = {
    ok: false,
    status: 403,
    code: "approval_digest_mismatch",
    message: "The digest does not match.",
  };

  beforeEach(() => {
    vi.mocked(buildClaimTx).mockReset().mockResolvedValue({ txCborHex: "00", expectedTxHash: "d".repeat(64) });
    vi.mocked(buildSubmitTx).mockReset().mockResolvedValue({ txCborHex: "00", expectedTxHash: "e".repeat(64) });
  });

  function setup(precheck?: (job: PrecheckJob) => Promise<PrecheckResult>, escrow: Partial<EscrowDatum> = {}) {
    const state = new SupplierState(1);
    const jobs = new JobStore();
    const execute = vi.fn(async () => ({ outputPayload: "{}" }));
    const deps: CustomRouteDeps = {
      chain: makeChain({}, { ...MATCHING, ...escrow }),
      state,
      config,
      supplierKey,
      jobs,
      identity: legacyOnlyIdentity,
      executor: precheck === undefined ? { execute } : { execute, precheck },
    };
    return { deps, state, jobs, execute };
  }

  async function post(deps: CustomRouteDeps) {
    const next = vi.fn();
    const { req, res, captured } = makeReqRes({ escrow_ref: ESCROW_REF_STR, payload: PAYLOAD });
    await makeCustomHandler(deps)(req, res, next as unknown as NextFunction);
    expect(next).not.toHaveBeenCalled();
    return captured;
  }

  it("asks the service once, with the payload and the context of the escrow, before it builds the Claim", async () => {
    const order: string[] = [];
    const precheck = vi.fn(async (_job: PrecheckJob): Promise<PrecheckResult> => {
      order.push("precheck");
      return { ok: true };
    });
    vi.mocked(buildClaimTx).mockImplementation(async () => {
      order.push("claim");
      return { txCborHex: "00", expectedTxHash: "d".repeat(64) };
    });
    const { deps, state } = setup(precheck);

    const captured = await post(deps);
    await vi.waitFor(() => expect(state.snapshot().activeSessions).toBe(0));

    expect(captured.statusCode).toBe(202);
    expect(order).toEqual(["precheck", "claim"]);
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(precheck).toHaveBeenCalledWith({
      capabilityId: advert.capability_id,
      requestPayload: PAYLOAD,
      jobRef: ESCROW_REF_STR,
      context: {
        escrowRef: ESCROW_REF_STR,
        advertRef: `${ADVERT_REF.txHash}#0`,
        advertModel: advert.model,
        buyerPkh: "4f".repeat(28),
        paymentLovelace: "1000000",
        deliverByMs: escrowDatum.deliver_by,
      },
    });
  });

  it("claims and runs the job when the service says go", async () => {
    const { deps, state, execute } = setup(async () => ({ ok: true }));

    const captured = await post(deps);
    await vi.waitFor(() => expect(state.snapshot().activeSessions).toBe(0));

    expect(captured.statusCode).toBe(202);
    expect(buildClaimTx).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("refuses with the status, the code and the text of the service, and builds no Claim", async () => {
    const { deps, state, jobs, execute } = setup(async () => REFUSAL);

    const captured = await post(deps);

    expect(captured.statusCode).toBe(403);
    expect(captured.body).toEqual({
      error: "approval_digest_mismatch",
      message: "The digest does not match.",
      reason: "approval_digest_mismatch",
    });
    expect(buildClaimTx).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    // The escrow stays Open and no job exists: the refusal is not a failed job.
    expect(jobs.count()).toBe(0);
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("serves the next request after a refusal, because the refusal frees the slot", async () => {
    const precheck = vi.fn(async (): Promise<PrecheckResult> => REFUSAL);
    precheck.mockResolvedValueOnce(REFUSAL).mockResolvedValueOnce({ ok: true });
    const { deps, state } = setup(precheck);

    expect((await post(deps)).statusCode).toBe(403);
    expect((await post(deps)).statusCode).toBe(202);
    await vi.waitFor(() => expect(state.snapshot().activeSessions).toBe(0));
    expect(buildClaimTx).toHaveBeenCalledTimes(1);
  });

  it("refuses with 503 when the check of an executor throws", async () => {
    const { deps, state } = setup(async () => {
      throw new Error("the check broke");
    });

    const captured = await post(deps);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: "precheck_failed", reason: "precheck_failed" });
    expect(JSON.stringify(captured.body)).not.toContain("the check broke");
    expect(buildClaimTx).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it.each([200, 302, 99, 600, 40.5])("refuses with 503 when an executor refuses with the status %s, which is not an error status", async (status) => {
    const { deps } = setup(async () => ({ ok: false, status, code: "x", message: "y" }));

    const captured = await post(deps);

    expect(captured.statusCode).toBe(503);
    expect(captured.body).toMatchObject({ error: "x", reason: "x", message: "y" });
    expect(buildClaimTx).not.toHaveBeenCalled();
  });

  it("answers supplier_busy and does not ask the service when this node already works another job", async () => {
    const precheck = vi.fn(async (): Promise<PrecheckResult> => ({ ok: true }));
    const { deps, state } = setup(precheck);
    expect(state.tryAcquire(`${"9".repeat(64)}#0`)).toBe(true);

    const captured = await post(deps);

    expect(captured.statusCode).toBe(409);
    expect(captured.body).toMatchObject({ reason: "supplier_busy" });
    expect(precheck).not.toHaveBeenCalled();
  });

  it("does not ask the service about a job that fails an earlier check", async () => {
    const precheck = vi.fn(async (): Promise<PrecheckResult> => ({ ok: true }));
    const { deps } = setup(precheck, { advert_ref: { txHash: "f".repeat(64), index: 0 } });

    const captured = await post(deps);

    expect(captured.body).toMatchObject({ reason: "wrong_advert" });
    expect(precheck).not.toHaveBeenCalled();
  });

  it("claims without a question when the executor has no check", async () => {
    const { deps, state } = setup(undefined);

    const captured = await post(deps);
    await vi.waitFor(() => expect(state.snapshot().activeSessions).toBe(0));

    expect(captured.statusCode).toBe(202);
    expect(buildClaimTx).toHaveBeenCalledTimes(1);
  });

  it("answers a busy service as it answers its own busy slot: 409 with the code supplier_busy", async () => {
    const busyNode = setup(async () => ({ ok: true }));
    expect(busyNode.state.tryAcquire(`${"9".repeat(64)}#0`)).toBe(true);
    const own = await post(busyNode.deps);

    const { deps, state } = setup(async () => ({ ok: false, status: 409, code: "busy", message: "The service is working on another job." }));
    const mapped = await post(deps);

    expect(mapped.statusCode).toBe(409);
    expect(mapped.body).toEqual(own.body);
    expect(mapped.body).toMatchObject({ reason: "supplier_busy", error: { reason: "supplier_busy" } });
    expect(buildClaimTx).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it.each([
    ["a 409 with another code", { status: 409, code: "unavailable" }],
    ["the code busy with another status", { status: 503, code: "busy" }],
  ])("does not map %s", async (_name, answer) => {
    const { deps } = setup(async () => ({ ok: false, ...answer, message: "The service says no." }));

    const captured = await post(deps);

    expect(captured.statusCode).toBe(answer.status);
    expect(captured.body).toEqual({ error: answer.code, message: "The service says no.", reason: answer.code });
  });
});
