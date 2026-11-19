/**
 * agent/src/routes/custom.identity.test.ts — the custom capability with the
 * escrow and advert layouts that carry an agent_id (upstream identity
 * registry plan, docs/IDENTITY_REGISTRY.md §6.1–§6.3 and §9.6).
 *
 * End to end through the real app: createApp with CAPABILITY_KIND=custom (so
 * the patched mount and the boot guard run), a MockChainProvider seeded with
 * real datums, and the real vendored builders on the mock backend. The only
 * stub is the operator's service behind SERVICE_URL (global fetch).
 *
 * Pins:
 *   1. a new escrow of this supplier's own agent: Claim and Submit read the
 *      agent's record as a reference input, the receipt has agent_did (9
 *      fields) and verifies against the escrow, and GET /v1/job renders the
 *      custom wire shape with the Submitted escrow output as submitted_ref.
 *   2. the agent comes from AGENT_ID, else from the configured new advert;
 *      AGENT_ID and a new advert that name different agents stop the route.
 *   3. refusals before any slot or Claim: an escrow of another agent, a new
 *      escrow without an own agent, a new escrow above the value cap.
 *   4. a record that fails the escrow contract's checks answers
 *      agent_not_eligible and frees the slot, with no transaction.
 *   5. a legacy escrow keeps the legacy path: no reference input, 8 fields.
 *   6. an escrow that names another advert, or that pays or holds less than
 *      the advert asks, is refused before any slot or Claim (wrong_advert,
 *      underpaid, bond_mismatch). A buyer bond above the advert bond is not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Application } from "express";
import { createHash } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";

import { MockChainProvider, type OutputReference } from "@marketplace/shared/chain";
import {
  canonicalize,
  decodeIdentityEscrowDatum,
  encodeAdvertDatum,
  encodeEscrowDatum,
  encodeIdentityAdvertDatum,
  encodeIdentityDatum,
  encodeIdentityEscrowDatum,
  type AdvertDatum,
  type IdentityAdvertDatum,
  type IdentityDatum,
  type IdentityEscrowDatum,
  type PlutusAddress,
} from "@marketplace/shared/cbor";
import { utf8ToHex, vectorIdFromSeed } from "@marketplace/shared/identity";
import { receiptResultHash, verifyEscrowReceipt, type SignedReceipt } from "@marketplace/shared/receipt";
import { loadBlueprint, loadIdentityBlueprint } from "@marketplace/shared/tx";

import { loadConfig } from "../config.js";
import { createApp } from "../server.js";
import { SupplierState } from "../state.js";
import { JobStore } from "../jobs.js";
import { supplierIdentity } from "../identity/agent.js";
import { deriveSupplierKey } from "../paper2agent/identity.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// A stand-in identity hash, not a deployment value: blake2b-224 of a label.
const IDENTITY_HASH = Buffer.from(
  blake2b(new TextEncoder().encode("did:vector test identity registry"), { dkLen: 28 }),
).toString("hex");
/** The vendored identity-marketplace blueprint with the stand-in hash applied. */
const IDENTITY = loadIdentityBlueprint({ identityHash: IDENTITY_HASH });

// Every key comes from a public label and controls nothing on any network.
const SUPPLIER = deriveSupplierKey("5e".repeat(32), 0);
const CONTROLLER = deriveSupplierKey("c0".repeat(32), 0);
const AGENT_ID = vectorIdFromSeed("a1".repeat(32), 0);
const OTHER_AGENT_ID = vectorIdFromSeed("b2".repeat(32), 1);
const BUYER_PKH = "4f".repeat(28);

const CAPABILITY = "records.extract.myproduct.v1";
const MODEL = "my-product-v1";
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };
const ESCROW_REF: OutputReference = { txHash: "e5".repeat(32), index: 0 };
const ESCROW_REF_STR = `${ESCROW_REF.txHash}#0`;
const RECORD_REF: OutputReference = { txHash: "7e".repeat(32), index: 0 };
const SERVICE_URL = "http://service.test/job";
const PAYLOAD = '[{"content":"the quick brown fox","role":"user"}]';
const OUTPUT = '{"echo":"the quick brown fox"}';
const REFUND_ADDRESS: PlutusAddress = {
  paymentCredential: { type: "VerificationKey", hash: BUYER_PKH },
  stakeCredential: null,
};

/** A record without a parent: CONTROLLER, the supplier key with purposes 9 (authentication + transaction), one Accountable Party. */
function agentRecord(capabilities: readonly string[]): IdentityDatum {
  return {
    controller: CONTROLLER.pubKeyHex,
    keys: [{ keyType: "Ed25519", key: SUPPLIER.pubKeyHex, purposes: 9, pop: null }],
    parties: [{
      role: "Accountable",
      signer: { type: "ControllerSet" },
      organisation: null,
      notBefore: 0,
      notAfter: null,
      rights: 3,
      removalAfter: null,
    }],
    guardianThreshold: 0,
    pendingRecovery: null,
    lineage: { type: "Root" },
    subagentEpoch: 0,
    name: utf8ToHex("template test agent"),
    description: "",
    framework: "",
    endpoint: utf8ToHex("https://agent.example"),
    capabilities: capabilities.map(utf8ToHex),
    createdAt: 1_760_000_000_000,
    status: { type: "Active" },
  };
}

function advertDatum(): AdvertDatum {
  return {
    supplier_pkh: SUPPLIER.pubKeyHash,
    capability_id: CAPABILITY,
    model: MODEL,
    max_output_tokens: 8192,
    max_processing_ms: 300_000,
    price_lovelace: 2_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    endpoint_url: "https://agent.example",
    detail_uri: "",
    detail_hash: "a".repeat(64),
    advertised_at: 0,
    status: "Active",
  };
}

function newEscrow(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  // Wall clock, as on a live chain: the runner budgets the service call
  // against deliver_by with Date.now().
  const postedAt = Date.now();
  return {
    buyer_pkh: BUYER_PKH,
    supplier_pkh: SUPPLIER.pubKeyHash,
    advert_ref: ADVERT_REF,
    capability_id: CAPABILITY,
    request_spec_hash: sha256(canonicalize({ capability_id: CAPABILITY, max_output_tokens: 8192, model: MODEL })),
    prompt_hash: sha256(PAYLOAD),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: postedAt + 330_000,
    posted_at: postedAt,
    submitted_at: null,
    result_receipt_hash: null,
    state: "Open",
    agent_id: AGENT_ID,
    refund: { address: REFUND_ADDRESS, datum: null },
    ...changes,
  };
}

interface SubmittedTx {
  body: {
    type: string;
    inputs: OutputReference[];
    referenceInputs?: OutputReference[];
    outputs: Array<{ datumHex?: string | null }>;
    requiredSigners: string[];
    meta?: Record<string, unknown>;
  };
  txHash: string;
}

/** Every synthetic (mock backend) transaction the chain receives, in order. */
function recordSubmissions(chain: MockChainProvider): SubmittedTx[] {
  const submitted: SubmittedTx[] = [];
  const submit = chain.submitTx.bind(chain);
  chain.submitTx = async (txCborHex: string) => {
    const length = Number.parseInt(txCborHex.slice(0, 8), 16);
    const body = JSON.parse(Buffer.from(txCborHex.slice(8, 8 + length * 2), "hex").toString("utf8")) as SubmittedTx["body"];
    const txHash = await submit(txCborHex);
    submitted.push({ body, txHash });
    return txHash;
  };
  return submitted;
}

interface SetupOptions {
  /** AGENT_ID in the env; undefined leaves it unset. Default: AGENT_ID. */
  agentId?: string;
  advert?: "legacy" | "identity";
  escrow?: "legacy" | Partial<IdentityEscrowDatum>;
  /** Capabilities of the agent's record; null seeds no record. */
  recordCapabilities?: string[] | null;
  /** The lovelace that the escrow output holds. Default: the payment and both bonds of its datum. */
  held?: bigint;
  /** More settings for loadConfig, for example SERVICE_PRECHECK_URL. */
  env?: Record<string, string>;
}

function setup(options: SetupOptions = {}) {
  const chain = new MockChainProvider();
  chain.advanceSlot(1_000);

  const advert = advertDatum();
  if (options.advert === "identity") {
    chain.seed({
      ref: ADVERT_REF,
      address: IDENTITY.advertScriptAddress(0),
      lovelace: 2_000_000n,
      assets: {},
      datumHex: encodeIdentityAdvertDatum({ ...advert, agent_id: AGENT_ID } satisfies IdentityAdvertDatum),
      scriptRef: null,
    });
  } else {
    chain.seed({
      ref: ADVERT_REF,
      address: loadBlueprint().advertScriptAddress(0),
      lovelace: 2_000_000n,
      assets: {},
      datumHex: encodeAdvertDatum(advert),
      scriptRef: null,
    });
  }

  const capabilities = options.recordCapabilities === undefined ? [CAPABILITY] : options.recordCapabilities;
  if (capabilities !== null) {
    chain.seed({
      ref: RECORD_REF,
      address: IDENTITY.identityScriptAddress(0),
      lovelace: 10_000_000n,
      assets: { [`${IDENTITY_HASH}${AGENT_ID}`]: 1n },
      datumHex: encodeIdentityDatum(agentRecord(capabilities)),
      scriptRef: null,
    });
  }

  // The escrow output holds payment + both bonds, as a Post locks them.
  const escrow = newEscrow(options.escrow === "legacy" ? {} : options.escrow);
  const locked = options.held ?? escrow.payment_lovelace + escrow.buyer_bond_lovelace + escrow.supplier_bond_lovelace;
  if (options.escrow === "legacy") {
    const { agent_id: _agentId, refund: _refund, ...legacy } = escrow;
    chain.seed({
      ref: ESCROW_REF,
      address: loadBlueprint().escrowScriptAddress(0),
      lovelace: locked,
      assets: {},
      datumHex: encodeEscrowDatum(legacy),
      scriptRef: null,
    });
  } else {
    chain.seed({
      ref: ESCROW_REF,
      address: IDENTITY.escrowScriptAddress(0),
      lovelace: locked,
      assets: {},
      datumHex: encodeIdentityEscrowDatum(escrow),
      scriptRef: null,
    });
  }

  const submitted = recordSubmissions(chain);
  const agentId = "agentId" in options ? options.agentId : AGENT_ID;
  const config = loadConfig({
    SUPPLIER_PRIV_KEY_HEX: SUPPLIER.privateKeyHex,
    OGMIOS_URL: "http://ogmios.test",
    ADVERT_REF: `${ADVERT_REF.txHash}#${ADVERT_REF.index}`,
    NETWORK_ID: "0",
    CAPABILITY_KIND: "custom",
    SERVICE_URL,
    SERVICE_TIMEOUT_MS: "60000",
    ADVERT_MAX_PROCESSING_MS: "300000",
    ...(agentId === undefined ? {} : { AGENT_ID: agentId }),
    ...options.env,
  });
  const jobs = new JobStore();
  const state = new SupplierState(1);
  const app = createApp({
    chain,
    state,
    config,
    supplierKey: SUPPLIER,
    jobs,
    identity: supplierIdentity(chain, 0, { blueprint: IDENTITY }),
  });
  return { app, chain, jobs, state, submitted, escrow, config };
}

const PRECHECK_URL = "http://service.test/precheck";

/** What the service answers at PRECHECK_URL. A test replaces it. */
let precheckAnswer: () => Response = () => new Response(null, { status: 200 });

const service = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  if (String(url) === PRECHECK_URL) return precheckAnswer();
  if (String(url) !== SERVICE_URL) throw new Error(`unexpected fetch ${String(url)}`);
  return new Response(OUTPUT, { status: 200 });
});

beforeEach(() => {
  service.mockClear();
  precheckAnswer = () => new Response(null, { status: 200 });
  vi.stubGlobal("fetch", service);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function postJob(app: Application, headers: Record<string, string> = {}) {
  return request(app).post("/v1/job").set(headers).send({ escrow_ref: ESCROW_REF_STR, payload: PAYLOAD });
}

/** The headers of the n-th call that the runtime made to the service, with lower-case names. */
function sentHeaders(call = 0): Record<string, string> {
  return Object.fromEntries(new Headers(service.mock.calls[call]![1]!.headers).entries());
}

describe("custom capability: a new escrow of this supplier's own agent", () => {
  it("Claim and Submit read the record, the receipt names the agent, and GET renders the custom wire shape", async () => {
    const { app, chain, jobs, state, submitted } = setup();

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    const jobId = posted.body.job_id as string;
    await vi.waitFor(() => expect(jobs.get(jobId)?.status).toBe("done"));

    const [claim, submit] = submitted;
    expect(claim!.body).toMatchObject({
      type: "claim",
      inputs: [ESCROW_REF],
      referenceInputs: [RECORD_REF],
      requiredSigners: [SUPPLIER.pubKeyHash],
      meta: { script_hash: IDENTITY.escrowScriptHash },
    });
    expect(decodeIdentityEscrowDatum(claim!.body.outputs[0]!.datumHex!)).toMatchObject({ state: "Claimed", agent_id: AGENT_ID });
    expect(submit!.body).toMatchObject({ type: "submit", referenceInputs: [RECORD_REF] });
    expect(service).toHaveBeenCalledTimes(1);

    const polled = await request(app).get(`/v1/job/${jobId}`);
    expect(polled.status).toBe(200);
    expect(polled.body.choices[0].message.content).toBe(OUTPUT);
    expect(polled.body.escrow_ref).toBe(ESCROW_REF_STR);
    expect(polled.body.submitted_ref).toBe(`${submit!.txHash}#0`);

    const signed: SignedReceipt = { receipt: polled.body.receipt, signature: polled.body.receipt_signature };
    expect(signed.receipt.agent_did).toBe(`did:vector:${AGENT_ID}`);
    expect(Object.keys(signed.receipt)).toHaveLength(9);
    // The custom wire contract: response_hash is sha256 over the raw output bytes.
    expect(signed.receipt.response_hash).toBe(sha256(OUTPUT));
    expect(verifyEscrowReceipt(signed, SUPPLIER.pubKeyHex,
      { escrow_ref: ESCROW_REF_STR, supplier_pkh: SUPPLIER.pubKeyHash, agent_id: AGENT_ID })).toBe(true);

    // submitted_ref is the Submitted escrow, and it commits this receipt.
    const submittedUtxo = await chain.queryUtxo({ txHash: submit!.txHash, index: 0 });
    expect(decodeIdentityEscrowDatum(submittedUtxo!.datumHex!)).toMatchObject({
      state: "Submitted",
      agent_id: AGENT_ID,
      result_receipt_hash: receiptResultHash(signed),
    });
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("takes the agent from the configured new advert when AGENT_ID is unset", async () => {
    const { app, jobs } = setup({ agentId: undefined, advert: "identity" });

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));
  });
});

describe("custom capability: refusals before any slot or Claim", () => {
  it("refuses an escrow of another agent", async () => {
    const { app, state, submitted } = setup({ escrow: { agent_id: OTHER_AGENT_ID } });

    const posted = await postJob(app);

    expect(posted.status).toBe(403);
    expect(posted.body.reason).toBe("wrong_agent");
    expect(submitted).toHaveLength(0);
    expect(service).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("refuses a new escrow when this supplier has no agent", async () => {
    const { app, submitted } = setup({ agentId: undefined });

    const posted = await postJob(app);

    expect(posted.status).toBe(503);
    expect(posted.body.reason).toBe("agent_not_configured");
    expect(submitted).toHaveLength(0);
  });

  it("refuses a new escrow above the value cap", async () => {
    const { app, submitted } = setup({ escrow: { payment_lovelace: 10_000_000_000n } });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body.reason).toBe("escrow_not_claimable");
    expect(submitted).toHaveLength(0);
  });

  it("refuses to serve when AGENT_ID and the new advert name different agents", async () => {
    const { app, submitted } = setup({ agentId: OTHER_AGENT_ID, advert: "identity" });

    const posted = await postJob(app);

    expect(posted.status).toBe(503);
    expect(posted.body.reason).toBe("agent_mismatch");
    expect(submitted).toHaveLength(0);
  });
});

describe("custom capability: the escrow against the advert", () => {
  // Each refusal has its twin above or in this block: the same request with the
  // escrow that matches the advert is claimed.
  it("refuses an escrow that names another advert, with the code in error and in reason", async () => {
    const { app, state, submitted } = setup({ escrow: { advert_ref: { txHash: "ff".repeat(32), index: 0 } } });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body).toEqual({
      error: "wrong_advert",
      reason: "wrong_advert",
      message: expect.stringContaining(`${"ff".repeat(32)}#0`),
    });
    expect(submitted).toHaveLength(0);
    expect(service).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("refuses an escrow with a payment below the advert price", async () => {
    const { app, submitted } = setup({ escrow: { payment_lovelace: 1_999_999n } });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body).toMatchObject({ error: "underpaid", reason: "underpaid" });
    expect(submitted).toHaveLength(0);
    expect(service).not.toHaveBeenCalled();
  });

  it("refuses an escrow with a bond below the advert bond", async () => {
    const { app, submitted } = setup({ escrow: { supplier_bond_lovelace: 999_999n } });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body).toMatchObject({ error: "bond_mismatch", reason: "bond_mismatch" });
    expect(submitted).toHaveLength(0);
  });

  it("refuses an escrow output that holds less than its datum says", async () => {
    const { app, submitted } = setup({ held: 3_999_999n });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body).toMatchObject({ error: "underpaid", reason: "underpaid" });
    expect(submitted).toHaveLength(0);
  });

  it("claims an escrow with a buyer bond above the advert bond, as a payment from a vault posts it", async () => {
    const { app, jobs, submitted } = setup({ escrow: { buyer_bond_lovelace: 1_633_000n } });

    const posted = await postJob(app);

    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));
    expect(submitted.map((tx) => tx.body.type)).toEqual(["claim", "submit"]);
  });
});

describe("custom capability: the job context for the service", () => {
  const CONTEXT_NAMES = [
    "x-vector-advert-model",
    "x-vector-advert-ref",
    "x-vector-buyer-pkh",
    "x-vector-deliver-by-ms",
    "x-vector-escrow-ref",
    "x-vector-payment-lovelace",
  ];

  it("sends the escrow, the advert, the buyer, the payment and the deadline to the service as headers", async () => {
    const { app, jobs, escrow } = setup();

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));

    const headers = sentHeaders();
    expect(headers["x-vector-escrow-ref"]).toBe(ESCROW_REF_STR);
    expect(headers["x-vector-advert-ref"]).toBe(`${ADVERT_REF.txHash}#${ADVERT_REF.index}`);
    expect(headers["x-vector-advert-model"]).toBe(MODEL);
    expect(headers["x-vector-buyer-pkh"]).toBe(BUYER_PKH);
    expect(headers["x-vector-payment-lovelace"]).toBe("2000000");
    expect(headers["x-vector-deliver-by-ms"]).toBe(String(escrow.deliver_by));
  });

  it("never passes a header of the buyer to the service, not even one with a name of the context", async () => {
    const { app, jobs } = setup();

    const posted = await postJob(app, {
      "x-vector-escrow-ref": `${"0".repeat(64)}#9`,
      "x-vector-advert-ref": `${"0".repeat(64)}#9`,
      "x-vector-advert-model": "forged-model",
      "x-vector-buyer-pkh": "0".repeat(56),
      "x-vector-payment-lovelace": "999999999999",
      "x-vector-deliver-by-ms": "1",
      "x-vector-extra": "forged",
      authorization: "Bearer forged",
      cookie: "session=forged",
    });
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));

    const headers = sentHeaders();
    // The values are the ones of the chain, and the names are exactly the six and the content type.
    expect(headers["x-vector-escrow-ref"]).toBe(ESCROW_REF_STR);
    expect(headers["x-vector-buyer-pkh"]).toBe(BUYER_PKH);
    expect(headers["x-vector-advert-model"]).toBe(MODEL);
    expect(Object.keys(headers).sort()).toEqual(["content-type", ...CONTEXT_NAMES]);
    expect(Object.values(headers).join(" ")).not.toContain("forged");
  });
});

describe("custom capability: the check of the service before the Claim", () => {
  const env = { SERVICE_PRECHECK_URL: PRECHECK_URL };

  it("asks the service before the Claim, with the payload and the same headers as the job call", async () => {
    const { app, chain, jobs } = setup({ env });
    const submit = vi.spyOn(chain, "submitTx");

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));

    expect(service.mock.calls.map(([url]) => String(url))).toEqual([PRECHECK_URL, SERVICE_URL]);
    expect(service.mock.calls.map(([, init]) => init?.body)).toEqual([PAYLOAD, PAYLOAD]);
    expect(sentHeaders(0)).toEqual(sentHeaders(1));
    // Order: the question, then the Claim, then the job.
    const [question, job] = service.mock.invocationCallOrder;
    const [claim] = submit.mock.invocationCallOrder;
    expect(question).toBeLessThan(claim!);
    expect(claim).toBeLessThan(job!);
  });

  it("refuses with the status of the service, leaves the escrow Open and calls no job", async () => {
    precheckAnswer = () => Response.json(
      { error: "approval_digest_mismatch", message: "The digest does not match." },
      { status: 403 },
    );
    const { app, chain, jobs, state, submitted } = setup({ env });

    const posted = await postJob(app);

    expect(posted.status).toBe(403);
    expect(posted.body).toEqual({
      error: "approval_digest_mismatch",
      message: "The digest does not match.",
      reason: "approval_digest_mismatch",
    });
    expect(submitted).toHaveLength(0);
    expect(service).toHaveBeenCalledTimes(1);
    expect(jobs.count()).toBe(0);
    expect(state.snapshot().activeSessions).toBe(0);
    const escrow = await chain.queryUtxo(ESCROW_REF);
    expect(decodeIdentityEscrowDatum(escrow!.datumHex!).state).toBe("Open");
  });

  it("claims the same escrow on a second try after a refusal, because the escrow stayed Open", async () => {
    const refusal = () => Response.json({ error: "busy" }, { status: 409 });
    precheckAnswer = refusal;
    const { app, jobs } = setup({ env });

    expect((await postJob(app)).status).toBe(409);
    precheckAnswer = () => new Response(null, { status: 204 });
    const second = await postJob(app);

    expect(second.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(second.body.job_id)?.status).toBe("done"));
  });

  it("answers a busy service with the answer of a busy supplier: 409 supplier_busy, the code that buyer clients retry", async () => {
    precheckAnswer = () => Response.json({ error: "busy" }, { status: 409 });
    const { app } = setup({ env });

    const posted = await postJob(app);

    expect(posted.status).toBe(409);
    expect(posted.body).toEqual({
      reason: "supplier_busy",
      message: "supplier is already working another job",
      error: { reason: "supplier_busy", message: "supplier is already working another job" },
    });
  });

  it("refuses with 503 when the service cannot be reached, and builds no Claim", async () => {
    precheckAnswer = () => {
      throw new TypeError("fetch failed");
    };
    const { app, submitted } = setup({ env });

    const posted = await postJob(app);

    expect(posted.status).toBe(503);
    expect(posted.body).toMatchObject({ error: "precheck_unreachable", reason: "precheck_unreachable" });
    expect(submitted).toHaveLength(0);
  });
});

describe("custom capability: the agent card", () => {
  const env = { PUBLIC_ORIGIN: "https://agent.example" };

  it("serves the card with the capability and the model of the advert, and a 200 on GET /", async () => {
    const { app } = setup({ env });

    const card = await request(app).get("/.well-known/agent-card.json");

    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({
      name: MODEL,
      capabilities: {},
      defaultInputModes: ["application/json"],
      defaultOutputModes: ["application/json"],
      skills: [{ id: CAPABILITY, name: CAPABILITY }],
      supportedInterfaces: [{ url: "https://agent.example/v1/job", protocolBinding: "vector-job-v1", protocolVersion: "1" }],
    });
    expect((await request(app).get("/")).status).toBe(200);
  });
});

describe("custom capability: every new setting unset", () => {
  // The agent of today: no check, no card, no watcher. Its answers do not change.
  it("serves neither the card nor a page on GET /, as before", async () => {
    const { app } = setup();

    expect((await request(app).get("/")).status).toBe(404);
    expect((await request(app).get("/.well-known/agent-card.json")).status).toBe(404);
  });

  it("has empty settings", () => {
    const { config } = setup();
    expect(config).toMatchObject({ servicePrecheckUrl: "", publicOrigin: "", releaseWatcher: false });
  });

  it("makes one call to the service for a job, to SERVICE_URL, with the body and the headers of the job call only", async () => {
    const { app, jobs } = setup();

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));

    expect(service).toHaveBeenCalledTimes(1);
    expect(String(service.mock.calls[0]![0])).toBe(SERVICE_URL);
    expect(service.mock.calls[0]![1]).toMatchObject({ method: "POST", body: PAYLOAD });
    expect(Object.keys(sentHeaders()).sort()).toEqual([
      "content-type",
      "x-vector-advert-model",
      "x-vector-advert-ref",
      "x-vector-buyer-pkh",
      "x-vector-deliver-by-ms",
      "x-vector-escrow-ref",
      "x-vector-payment-lovelace",
    ]);
  });
});

describe("custom capability: a record that fails the escrow contract's checks", () => {
  it("answers agent_not_eligible when the record does not list the capability, and frees the slot", async () => {
    const { app, state, submitted } = setup({ recordCapabilities: ["another.capability.v1"] });

    const posted = await postJob(app);

    expect(posted.status).toBe(503);
    expect(posted.body.reason).toBe("agent_not_eligible");
    expect(posted.body.message).toMatch(/capability not listed/);
    expect(submitted).toHaveLength(0);
    expect(service).not.toHaveBeenCalled();
    expect(state.snapshot().activeSessions).toBe(0);
  });

  it("answers agent_not_eligible when the agent has no record", async () => {
    const { app, submitted } = setup({ recordCapabilities: null });

    const posted = await postJob(app);

    expect(posted.status).toBe(503);
    expect(posted.body.reason).toBe("agent_not_eligible");
    expect(submitted).toHaveLength(0);
  });
});

describe("custom capability: a legacy escrow", () => {
  it("keeps the legacy path: no record reference input and an 8-field receipt", async () => {
    const { app, jobs, submitted } = setup({ agentId: undefined, escrow: "legacy" });

    const posted = await postJob(app);
    expect(posted.status).toBe(202);
    await vi.waitFor(() => expect(jobs.get(posted.body.job_id)?.status).toBe("done"));

    expect(submitted.map((tx) => tx.body.type)).toEqual(["claim", "submit"]);
    expect(submitted[0]!.body.referenceInputs).toBeUndefined();
    const polled = await request(app).get(`/v1/job/${posted.body.job_id}`);
    expect(Object.keys(polled.body.receipt)).toHaveLength(8);
    expect(polled.body.receipt).not.toHaveProperty("agent_did");
  });
});
