/**
 * customJobRunner.test.ts — executor-seam behaviour of runCustomJob.
 *
 * No vendored runner test was archived with the core, so this tests at the
 * seam the template owns: a fake Executor, a fake JobStore recording
 * transitions, a stubbed chain + mocked buildSubmitTx. Everything below the
 * seam (receipt build/sign, Submit, lock release) is the vendored money path
 * and is exercised, not re-specified.
 *
 * Pins:
 *   1. success  → the stored payload's output text === executor outputPayload,
 *                 submitted_ref = "<Submit tx hash>#0", job reaches "done",
 *                 lock released.
 *   2. failure  → ExecutorError reason lands verbatim in jobs.fail (502).
 *   3. the runner NEVER rejects (non-ExecutorError, submit failure included).
 *   4. wire contract: response_hash === sha256(utf8(outputPayload)) — no
 *      canonicalisation, no wrapping. The buyer side hashes the same bytes.
 *   5. deadline: executor deadlineMs = min(serviceTimeoutMs, deliver_by - now
 *      - 30s Submit reserve) — a job whose escrow deliver_by is near-now gets a
 *      smaller budget than the configured service timeout, and one with less
 *      than the reserve left fails deliver_by_too_close without the service
 *      ever being called. Both sides of that boundary are pinned.
 *   6. escrow layouts: a legacy escrow gets the 8-field receipt; an escrow
 *      with an agent_id gets agent_did = "did:vector:<agent_id>" (9 fields),
 *      and its Submit reads the agent's record (lookup + identity blueprint).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum, IdentityEscrowDatum } from "@marketplace/shared/cbor";
import { responseOutputText } from "@marketplace/shared/responses";
import type { IdentityBlueprint, WalletKey } from "@marketplace/shared/tx";
import type * as TxModule from "@marketplace/shared/tx";

import type { SupplierConfig } from "./config.js";
import type { JobStore, JobFailure, JobResponsePayload, ChatJobResponsePayload } from "./jobs.js";
import { SupplierState } from "./state.js";
import { ExecutorError, type Executor, type ExecutorJob } from "./executor/executor.js";
import type { SupplierIdentity } from "./identity/agent.js";

// buildSubmitTx is the one tx-package value this test replaces: it would build
// and submit a real Submit. The rest of the barrel stays real, because the
// vendored identity helpers the runner calls (receiptAgentDid,
// identityOptions) read the escrow layout through it.
const buildSubmitTx = vi.hoisted(() =>
  vi.fn(async (_params: unknown) => ({ txCborHex: "00", expectedTxHash: "b".repeat(64) })),
);
vi.mock("@marketplace/shared/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof TxModule>()),
  buildSubmitTx,
}));

import { runCustomJob, type RunCustomJobParams } from "./customJobRunner.js";

// ─── Fakes ─────────────────────────────────────────────────────────────────

class FakeJobStore {
  readonly transitions: string[] = [];
  payload?: JobResponsePayload;
  failure?: JobFailure;

  setRunning(jobId: string): void {
    this.transitions.push(`setRunning:${jobId}`);
  }
  complete(jobId: string, payload: JobResponsePayload): void {
    this.transitions.push(`complete:${jobId}`);
    this.payload = payload;
  }
  fail(jobId: string, failure: JobFailure): void {
    this.transitions.push(`fail:${jobId}`);
    this.failure = failure;
  }
}

function fakeExecutor(impl: (job: ExecutorJob) => Promise<{ outputPayload: string }>): Executor {
  return { execute: vi.fn(impl) };
}

const ESCROW_REF = `${"c".repeat(64)}#0`;
const CLAIMED_REF: OutputReference = { txHash: "d".repeat(64), index: 0 };
const JOB_ID = "job-1";

const advert = {
  capability_id: "custom.echo.v1",
  model: "echo-service-v1",
} as unknown as AdvertDatum;

// deliver_by defaults far in the future so tests that don't care about the
// deadline cap (test 5 below) see deadlineMs === serviceTimeoutMs unchanged.
const escrowDatum = {
  prompt_hash: "ab".repeat(32),
  deliver_by: Date.now() + 24 * 60 * 60 * 1000,
} as unknown as EscrowDatum;

const supplierKey: WalletKey = {
  privateKeyHex: "1f".repeat(32),
  pubKeyHex: "2f".repeat(32),
  pubKeyHash: "3f".repeat(28),
  address: "addr_test1_fake",
};

// The supplier's agent (64 lowercase hex) for the escrow layout with agent_id.
const AGENT_ID = "a1".repeat(32);

let jobs: FakeJobStore;
let state: SupplierState;

function makeParams(
  executor: Executor,
  overrides: Partial<SupplierConfig> = {},
  escrowOverrides: Partial<IdentityEscrowDatum> = {},
  identity?: SupplierIdentity,
): RunCustomJobParams {
  const chain = { awaitTx: vi.fn(async () => undefined) } as unknown as ChainProvider;
  const config = { serviceTimeoutMs: 5_000, ...overrides } as unknown as SupplierConfig;
  return {
    deps: {
      chain,
      state,
      config,
      supplierKey,
      jobs: jobs as unknown as JobStore,
      identity,
    },
    executor,
    jobId: JOB_ID,
    escrowRef: ESCROW_REF,
    claimedRef: CLAIMED_REF,
    advert,
    escrowDatum: { ...escrowDatum, ...escrowOverrides } as EscrowDatum,
    requestBody: { payload: '{"in":1}' },
  };
}

beforeEach(() => {
  jobs = new FakeJobStore();
  state = new SupplierState(1);
  state.tryAcquire(ESCROW_REF);
  buildSubmitTx.mockClear();
  buildSubmitTx.mockResolvedValue({ txCborHex: "00", expectedTxHash: "b".repeat(64) });
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("runCustomJob", () => {
  it("stores the executor output as the job payload and completes the job", async () => {
    const executor = fakeExecutor(async () => ({ outputPayload: "out" }));

    await runCustomJob(makeParams(executor));

    expect(jobs.transitions).toEqual([`setRunning:${JOB_ID}`, `complete:${JOB_ID}`]);
    const payload = jobs.payload as ChatJobResponsePayload;
    expect(responseOutputText(payload.output)).toBe("out");
    expect(payload.receipt_signature).toMatch(/^[0-9a-f]{128}$/);
    // The Submitted escrow is the first output of the Submit tx.
    expect(payload.submitted_ref).toBe(`${"b".repeat(64)}#0`);
    expect(jobs.failure).toBeUndefined();
    // lock released in the finally, whatever the outcome
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("keeps the 8-field receipt for a legacy escrow", async () => {
    await runCustomJob(makeParams(fakeExecutor(async () => ({ outputPayload: "out" }))));

    const receipt = (jobs.payload as ChatJobResponsePayload).receipt;
    expect(Object.keys(receipt)).toHaveLength(8);
    expect(receipt).not.toHaveProperty("agent_did");
  });

  it("names the agent in the receipt and reads its record on Submit for an escrow with agent_id", async () => {
    const blueprint = { identityHash: "1d".repeat(28) } as unknown as IdentityBlueprint;
    const identity: SupplierIdentity = { lookupRecord: vi.fn(async () => null), blueprint: () => blueprint };

    await runCustomJob(makeParams(
      fakeExecutor(async () => ({ outputPayload: "out" })),
      {},
      { agent_id: AGENT_ID, refund: null },
      identity,
    ));

    const receipt = (jobs.payload as ChatJobResponsePayload).receipt;
    expect(receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
    expect(Object.keys(receipt)).toHaveLength(9);
    expect(buildSubmitTx).toHaveBeenCalledWith(expect.objectContaining({
      escrowRef: CLAIMED_REF,
      lookupRecord: identity.lookupRecord,
      identityBlueprint: blueprint,
    }));
  });

  it("passes the request payload and the service budget through to the executor", async () => {
    const seen: ExecutorJob[] = [];
    const executor = fakeExecutor(async (job) => {
      seen.push(job);
      return { outputPayload: "out" };
    });

    await runCustomJob(makeParams(executor, { serviceTimeoutMs: 7_000 }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      capabilityId: "custom.echo.v1",
      requestPayload: '{"in":1}',
      deadlineMs: 7_000,
      jobRef: ESCROW_REF,
    });
  });

  it("caps the executor deadline at deliver_by minus the Submit reserve when that is sooner than the service timeout", async () => {
    const seen: ExecutorJob[] = [];
    const executor = fakeExecutor(async (job) => {
      seen.push(job);
      return { outputPayload: "out" };
    });
    // 45s of window: 30s goes to the Submit reserve, ~15s is left to work with.
    const deliverBy = Date.now() + 45_000;

    await runCustomJob(
      makeParams(executor, { serviceTimeoutMs: 30_000 }, { deliver_by: deliverBy }),
    );

    expect(seen).toHaveLength(1);
    // Never the constant configured value, and never the raw remaining window:
    // the reserve has to come off the top or Submit has no time to land.
    expect(seen[0].deadlineMs).toBeGreaterThan(0);
    expect(seen[0].deadlineMs).toBeLessThanOrEqual(15_000);
    expect(seen[0].deadlineMs).toBeGreaterThan(13_000);
  });

  it("fails deliver_by_too_close, without calling the service, when the reserve eats the whole window", async () => {
    const executor = fakeExecutor(async () => ({ outputPayload: "out" }));
    // 20s left, under the 30s Submit reserve: any result would be unsubmittable.
    const deliverBy = Date.now() + 20_000;

    await expect(
      runCustomJob(makeParams(executor, { serviceTimeoutMs: 30_000 }, { deliver_by: deliverBy })),
    ).resolves.toBeUndefined();

    expect(executor.execute).not.toHaveBeenCalled();
    expect(buildSubmitTx).not.toHaveBeenCalled();
    expect(jobs.transitions).toEqual([`setRunning:${JOB_ID}`, `fail:${JOB_ID}`]);
    expect(jobs.failure).toMatchObject({ httpStatus: 502, reason: "deliver_by_too_close" });
    // The lock is released on this path too, or the node serves nothing else.
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("still calls the service one millisecond above the reserve boundary", async () => {
    // Boundary pin from the other side: 30s + 5s of slack must NOT fast-fail.
    // Together with the test above this brackets deadlineMs <= 0 exactly.
    const seen: ExecutorJob[] = [];
    const executor = fakeExecutor(async (job) => {
      seen.push(job);
      return { outputPayload: "out" };
    });

    await runCustomJob(
      makeParams(executor, { serviceTimeoutMs: 30_000 }, { deliver_by: Date.now() + 35_000 }),
    );

    expect(seen).toHaveLength(1);
    expect(seen[0].deadlineMs).toBeGreaterThan(0);
    expect(seen[0].deadlineMs).toBeLessThanOrEqual(5_000);
    expect(jobs.failure).toBeUndefined();
  });

  it("hashes the raw output bytes into response_hash (wire contract, no normalisation)", async () => {
    const executor = fakeExecutor(async () => ({ outputPayload: '{"echo":"hi","length":2}' }));

    await runCustomJob(makeParams(executor));

    const payload = jobs.payload as ChatJobResponsePayload;
    const receipt = payload.receipt as { response_hash: string; prompt_hash: string };
    expect(receipt.response_hash).toBe(
      createHash("sha256").update('{"echo":"hi","length":2}', "utf8").digest("hex"),
    );
    // prompt_hash is carried over from the escrow datum untouched
    expect(receipt.prompt_hash).toBe(escrowDatum.prompt_hash);
  });

  it("fails the job with the ExecutorError reason and never rejects", async () => {
    const executor: Executor = {
      execute: vi.fn(async () => {
        throw new ExecutorError("service_timeout", "service call failed after 5000ms");
      }),
    };

    await expect(runCustomJob(makeParams(executor))).resolves.toBeUndefined();

    expect(jobs.transitions).toEqual([`setRunning:${JOB_ID}`, `fail:${JOB_ID}`]);
    expect(jobs.failure).toMatchObject({ httpStatus: 502, reason: "service_timeout" });
    expect(jobs.payload).toBeUndefined();
    expect(buildSubmitTx).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("maps a non-ExecutorError rejection to service_failure and never rejects", async () => {
    const executor: Executor = {
      execute: vi.fn(async () => {
        throw new Error("boom");
      }),
    };

    await expect(runCustomJob(makeParams(executor))).resolves.toBeUndefined();

    expect(jobs.failure).toMatchObject({ httpStatus: 502, reason: "service_failure", message: "boom" });
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("fails with submit_failed when the Submit tx cannot be built, and never rejects", async () => {
    buildSubmitTx.mockRejectedValue(new Error("no collateral utxo"));
    const executor = fakeExecutor(async () => ({ outputPayload: "out" }));

    await expect(runCustomJob(makeParams(executor))).resolves.toBeUndefined();

    expect(jobs.failure).toMatchObject({ httpStatus: 502, reason: "submit_failed" });
    expect(jobs.failure?.message).toContain("no collateral utxo");
    expect(jobs.payload).toBeUndefined();
    expect(state.snapshot().activeSessions).toBe(0);
  });
});
