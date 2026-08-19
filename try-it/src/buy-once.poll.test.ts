/**
 * try-it/src/buy-once.poll.test.ts — the hardening behaviours, pinned.
 *
 * Why these matter enough to test: once the supplier has Submitted, giving up
 * is not free. `reclaim.ts` only spends Open|Claimed escrows, and `release.ts`
 * lets the supplier take payment + both bonds 600 s after submitted_at. So a
 * dropped connection during polling, or a body the agent's 1mb JSON parser
 * refuses, costs real money. Each guard below exists to avoid paying for a
 * blip.
 *
 * `@marketplace/shared/tx` is mocked wholesale (lucid/CML WASM); none of the
 * functions under test touch it.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@marketplace/shared/tx", () => ({
  buildPostEscrowTx: vi.fn(),
  buildAcceptTx: vi.fn(),
}));

import {
  pollJob,
  isTransientPollFailure,
  payloadSizeError,
  loadEnvConfig,
  BuyError,
  POLL_ATTEMPTS,
  MAX_WIRE_PAYLOAD_BYTES,
  type HttpResult,
} from "./buy-once.js";

const DONE_BODY = {
  choices: [{ index: 0, message: { role: "assistant", content: "output bytes" }, finish_reason: "stop" }],
  receipt: { prompt_hash: "ab".repeat(32) },
  receipt_signature: "cd".repeat(64),
};

function ok200(): HttpResult {
  return { status: 200, body: DONE_BODY, text: JSON.stringify(DONE_BODY) };
}

function unreachable(): BuyError {
  return new BuyError("agent_unreachable", "fetch failed");
}

const POLL_OPTS = { endpoint: "http://agent.invalid", jobId: "job-1", intervalMs: 1, timeoutMs: 5_000, retryBackoffMs: 1 };

describe("pollJob retry", () => {
  it("rides out transient failures and returns the done job", async () => {
    let call = 0;
    const request = vi.fn(async (): Promise<HttpResult> => {
      call += 1;
      if (call < POLL_ATTEMPTS) throw unreachable();
      return ok200();
    });

    const done = await pollJob({ ...POLL_OPTS, request });

    expect(done.output).toBe("output bytes");
    expect(request).toHaveBeenCalledTimes(POLL_ATTEMPTS);
  });

  it("gives up after POLL_ATTEMPTS and reports the last failure", async () => {
    const request = vi.fn(async (): Promise<HttpResult> => { throw unreachable(); });

    await expect(pollJob({ ...POLL_OPTS, request })).rejects.toMatchObject({ reason: "agent_unreachable" });
    expect(request).toHaveBeenCalledTimes(POLL_ATTEMPTS);
  });

  it("does NOT retry a failed job — the agent's own reason is a verdict", async () => {
    const body = { status: "failed", reason: "service_failure", message: "boom" };
    const request = vi.fn(async (): Promise<HttpResult> => ({ status: 502, body, text: JSON.stringify(body) }));

    await expect(pollJob({ ...POLL_OPTS, request })).rejects.toMatchObject({ reason: "job_failed" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps polling while the job is still running", async () => {
    let call = 0;
    const request = vi.fn(async (): Promise<HttpResult> => {
      call += 1;
      if (call === 1) return { status: 202, body: { status: "running" }, text: "{}" };
      return ok200();
    });

    const done = await pollJob({ ...POLL_OPTS, request });

    expect(done.output).toBe("output bytes");
    expect(request).toHaveBeenCalledTimes(2);
  });
});

describe("isTransientPollFailure", () => {
  it("counts transport errors and body-less 5xx as transient, verdicts as final", () => {
    expect(isTransientPollFailure({ kind: "threw", err: unreachable() })).toBe(true);
    expect(isTransientPollFailure({ kind: "http", res: { status: 503, body: null, text: "bad gateway" } })).toBe(true);
    // The agent's own failures always carry a machine-readable reason.
    expect(isTransientPollFailure({ kind: "http", res: { status: 502, body: { reason: "submit_failed" }, text: "" } })).toBe(false);
    expect(isTransientPollFailure({ kind: "http", res: { status: 404, body: { reason: "job_not_found" }, text: "" } })).toBe(false);
    expect(isTransientPollFailure({ kind: "threw", err: new BuyError("job_timeout", "…") })).toBe(false);
  });
});

describe("payloadSizeError", () => {
  it("passes a normal payload and refuses one the agent's parser would drop", () => {
    expect(payloadSizeError('[{"content":"hello","role":"user"}]')).toBeNull();

    const oversized = "x".repeat(MAX_WIRE_PAYLOAD_BYTES + 1);
    const err = payloadSizeError(oversized);
    expect(err).toContain(String(MAX_WIRE_PAYLOAD_BYTES));
    expect(err).toContain("1mb");
  });

  it("measures bytes, not characters", () => {
    // Multi-byte characters must count at their UTF-8 weight or the guard
    // passes a body the parser rejects.
    const justUnderInChars = "✓".repeat(MAX_WIRE_PAYLOAD_BYTES / 2);
    expect(payloadSizeError(justUnderInChars)).not.toBeNull();
  });
});

describe("loadEnvConfig", () => {
  const base = {
    BUYER_PRIV_KEY_HEX: "ab".repeat(32),
    NETWORK_ID: "1",
    VECTOR_ZERO_TIME_MS: "1752057484000",
  };

  it("accepts an http(s) Ogmios URL", () => {
    expect(loadEnvConfig({ ...base, OGMIOS_URL: "https://ogmios.example" }).ogmiosUrl)
      .toBe("https://ogmios.example");
  });

  it("rejects a wss:// Ogmios URL naming the actual mistake", () => {
    expect(() => loadEnvConfig({ ...base, OGMIOS_URL: "wss://ogmios.example" }))
      .toThrow(/JSON-RPC over HTTP, not websockets/);
  });
});
