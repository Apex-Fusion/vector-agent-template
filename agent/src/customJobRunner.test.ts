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
 *   1. success  → payload.choices[0].message.content === executor outputPayload,
 *                 job reaches "done", lock released.
 *   2. failure  → ExecutorError reason lands verbatim in jobs.fail (502).
 *   3. the runner NEVER rejects (non-ExecutorError, submit failure included).
 *   4. wire contract: response_hash === sha256(utf8(outputPayload)) — no
 *      canonicalisation, no wrapping. The buyer side hashes the same bytes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "crypto";

import type { ChainProvider, OutputReference } from "@marketplace/shared/chain";
import type { AdvertDatum, EscrowDatum } from "@marketplace/shared/cbor";
import type { WalletKey } from "@marketplace/shared/tx";

import type { SupplierConfig } from "./config.js";
import type { JobStore, JobFailure, JobResponsePayload, ChatJobResponsePayload } from "./jobs.js";
import { SupplierState } from "./state.js";
import { ExecutorError, type Executor, type ExecutorJob } from "./executor/executor.js";

// buildSubmitTx is the only value import customJobRunner takes from the tx
// package; mocking the whole module keeps lucid off the test's import graph.
const buildSubmitTx = vi.hoisted(() =>
  vi.fn(async () => ({ txCborHex: "00", expectedTxHash: "b".repeat(64) })),
);
vi.mock("@marketplace/shared/tx", () => ({ buildSubmitTx }));

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

const escrowDatum = {
  prompt_hash: "ab".repeat(32),
} as unknown as EscrowDatum;

const supplierKey: WalletKey = {
  privateKeyHex: "1f".repeat(32),
  pubKeyHex: "2f".repeat(32),
  pubKeyHash: "3f".repeat(28),
  address: "addr_test1_fake",
};

let jobs: FakeJobStore;
let state: SupplierState;

function makeParams(executor: Executor, overrides: Partial<SupplierConfig> = {}): RunCustomJobParams {
  const chain = { awaitTx: vi.fn(async () => undefined) } as unknown as ChainProvider;
  const config = { serviceTimeoutMs: 5_000, ...overrides } as unknown as SupplierConfig;
  return {
    deps: {
      chain,
      state,
      config,
      supplierKey,
      jobs: jobs as unknown as JobStore,
    },
    executor,
    jobId: JOB_ID,
    escrowRef: ESCROW_REF,
    claimedRef: CLAIMED_REF,
    advert,
    escrowDatum,
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
    expect(payload.choices[0].message.content).toBe("out");
    expect(payload.receipt_signature).toMatch(/^[0-9a-f]{128}$/);
    expect(jobs.failure).toBeUndefined();
    // lock released in the finally, whatever the outcome
    expect(state.snapshot().activeSessions).toBe(0);
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
