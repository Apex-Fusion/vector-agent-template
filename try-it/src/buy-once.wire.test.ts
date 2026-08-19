/**
 * try-it/src/buy-once.wire.test.ts — pins the buyer half of the custom
 * capability's wire contract.
 *
 * The failure this guards against is expensive and silent-looking: if the
 * string the buyer POSTs is not byte-identical to the preimage the vendored
 * `buildPostEscrowTx` hashed into the escrow datum, EVERY purchase 409s with
 * `prompt_mismatch` after the escrow is already funded on chain.
 *
 * So this test computes the agent's side independently — `sha256(utf8(payload))`,
 * exactly as agent/src/routes/custom.ts does — and the buyer's side through
 * `buildWirePayload`, and requires them to agree, with the real `canonicalize`
 * from the vendored package in the middle.
 *
 * `@marketplace/shared/tx` is mocked wholesale: buy-once imports the escrow
 * builders from that barrel, which traces into lucid-evolution / CML WASM
 * (and, in this pnpm layout, a broken libsodium-wrappers-sumo relative
 * import). `buildWirePayload` touches none of it. Same workaround the agent's
 * route/runner tests use.
 */

import { describe, it, expect, vi } from "vitest";
import { createHash } from "crypto";
import { canonicalize } from "@marketplace/shared/cbor";

vi.mock("@marketplace/shared/tx", () => ({
  buildPostEscrowTx: vi.fn(),
  buildAcceptTx: vi.fn(),
}));

import { buildWirePayload, parseArgs, loadEnvConfig } from "./buy-once.js";

/** Verbatim mirror of agent/src/routes/custom.ts's prompt-hash recomputation. */
function agentSidePromptHash(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

describe("buildWirePayload", () => {
  it("puts the hashed preimage on the wire, so both sides derive one prompt_hash", () => {
    const { messages, wirePayload, promptHash } = buildWirePayload("the quick brown fox");

    // Buyer side: what buildPostEscrowTx hashes (postEscrow.ts hashes canonicalize(messages)).
    expect(wirePayload).toBe(canonicalize(messages));
    // Agent side: what routes/custom.ts recomputes from the POSTed payload string.
    expect(agentSidePromptHash(wirePayload)).toBe(promptHash);
  });

  it("uses the one-element canonical chat envelope (shape is part of the contract)", () => {
    const { wirePayload } = buildWirePayload("hello");
    expect(wirePayload).toBe('[{"content":"hello","role":"user"}]');
  });

  it("survives payload text that JSON must escape", () => {
    const raw = 'line1\nline2\t"quoted" \\ backslash — unicode ✓';
    const { messages, wirePayload, promptHash } = buildWirePayload(raw);

    expect(wirePayload).toBe(canonicalize(messages));
    expect(agentSidePromptHash(wirePayload)).toBe(promptHash);
    // The payload survives the round-trip the operator's service will do.
    expect(JSON.parse(wirePayload)[0].content).toBe(raw.normalize("NFC"));
  });
});

describe("cli surface", () => {
  it("rejects a malformed advert ref instead of posting an escrow into the void", () => {
    expect(() => parseArgs(["--advert-ref", "nope", "--endpoint", "http://x", "--payload-file", "p"]))
      .toThrow(/--advert-ref must be/);
  });

  it("requires VECTOR_ZERO_TIME_MS rather than defaulting to a foreign genesis", () => {
    expect(() => loadEnvConfig({
      BUYER_PRIV_KEY_HEX: "ab".repeat(32),
      OGMIOS_URL: "http://ogmios.invalid",
      NETWORK_ID: "1",
    })).toThrow(/VECTOR_ZERO_TIME_MS is required/);
  });
});
