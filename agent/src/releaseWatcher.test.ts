/**
 * agent/src/releaseWatcher.test.ts — the release watcher.
 *
 * The guard tests use a stand-in for the Release builder, so that they see
 * whether the watcher asks for a Release at all: the real builder refuses an
 * early or a foreign Release too, and that would hide a broken guard of the
 * watcher. One test uses the real builder on the mock chain.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { blake2b } from "@noble/hashes/blake2b";

import { MockChainProvider, type OutputReference } from "@marketplace/shared/chain";
import {
  encodeEscrowDatum,
  encodeIdentityAdvertDatum,
  encodeIdentityEscrowDatum,
  type IdentityAdvertDatum,
  type IdentityEscrowDatum,
} from "@marketplace/shared/cbor";
import { vectorIdFromSeed } from "@marketplace/shared/identity";
import { loadBlueprint, loadIdentityBlueprint, type BuildResult, type ReleaseParams } from "@marketplace/shared/tx";

import { SupplierState } from "./state.js";
import { supplierIdentity } from "./identity/agent.js";
import { deriveSupplierKey } from "./paper2agent/identity.js";
import {
  RELEASE_RETRY_MS,
  RELEASE_WATCH_INTERVAL_MS,
  maybeStartReleaseWatcher,
  releasable,
  startReleaseWatcher,
  type ReleaseOwner,
  type ReleaseWatcher,
} from "./releaseWatcher.js";

// Keys and ids come from public labels and control nothing on any network.
const IDENTITY_HASH = Buffer.from(blake2b(new TextEncoder().encode("did:vector test identity registry"), { dkLen: 28 })).toString("hex");
const IDENTITY = loadIdentityBlueprint({ identityHash: IDENTITY_HASH });
const SUPPLIER = deriveSupplierKey("5e".repeat(32), 0);
const OTHER = deriveSupplierKey("6f".repeat(32), 0);
const AGENT_ID = vectorIdFromSeed("a1".repeat(32), 0);
const OTHER_AGENT_ID = vectorIdFromSeed("b2".repeat(32), 1);
const ADVERT_REF: OutputReference = { txHash: "ad".repeat(32), index: 0 };

const SUBMITTED_AT = 1_000_000;
const DUE = SUBMITTED_AT + 600_000;
const owner: ReleaseOwner = { supplierPkh: SUPPLIER.pubKeyHash, agentId: AGENT_ID };

function submitted(changes: Partial<IdentityEscrowDatum> = {}): IdentityEscrowDatum {
  return {
    buyer_pkh: "4f".repeat(28),
    supplier_pkh: SUPPLIER.pubKeyHash,
    advert_ref: ADVERT_REF,
    capability_id: "x.y.v1",
    request_spec_hash: "ab".repeat(32),
    prompt_hash: "cd".repeat(32),
    payment_lovelace: 2_000_000n,
    buyer_bond_lovelace: 1_000_000n,
    supplier_bond_lovelace: 1_000_000n,
    deliver_by: 900_000,
    posted_at: 0,
    submitted_at: SUBMITTED_AT,
    result_receipt_hash: "ef".repeat(32),
    state: "Submitted",
    agent_id: AGENT_ID,
    refund: null,
    ...changes,
  };
}

type Layout = "identity" | "legacy";
interface Seeded { ref: OutputReference; datum: IdentityEscrowDatum; layout: Layout; at?: Layout }
const refOf = (n: number): OutputReference => ({ txHash: n.toString(16).padStart(2, "0").repeat(32), index: 0 });
const text = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;

function seed(chain: MockChainProvider, { ref, datum, layout, at }: Seeded): void {
  const { agent_id: _agent, refund: _refund, ...legacy } = datum;
  chain.seed({
    ref,
    address: (at ?? layout) === "identity" ? IDENTITY.escrowScriptAddress(0) : loadBlueprint().escrowScriptAddress(0),
    lovelace: 4_000_000n,
    assets: {},
    datumHex: layout === "identity" ? encodeIdentityEscrowDatum(datum) : encodeEscrowDatum(legacy),
    scriptRef: null,
  });
}

const watchers: ReleaseWatcher[] = [];
afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
  vi.useRealTimers();
});

interface SetupOptions {
  escrows?: Seeded[];
  now?: number;
  agentId?: string | undefined;
  useRealBuilder?: boolean;
  chain?: MockChainProvider;
}

function setup(options: SetupOptions = {}) {
  const chain = options.chain ?? new MockChainProvider();
  for (const escrow of options.escrows ?? []) seed(chain, escrow);
  chain.awaitTx = vi.fn(async () => undefined);
  const state = new SupplierState(1);
  const built = vi.fn(async (_params: ReleaseParams): Promise<BuildResult> => ({ txCborHex: "00", expectedTxHash: "7".repeat(64) }));
  const clock = { now: options.now ?? DUE };
  const logs: string[] = [];
  const watcher = startReleaseWatcher({
    chain,
    state,
    supplierKey: SUPPLIER,
    identity: supplierIdentity(chain, 0, { blueprint: IDENTITY }),
    networkId: 0,
    agentId: "agentId" in options ? options.agentId : AGENT_ID,
    advertRef: ADVERT_REF,
    now: () => clock.now,
    ...(options.useRealBuilder ? {} : { buildRelease: built }),
  }, { log: (line) => logs.push(line) });
  watchers.push(watcher);
  return { chain, state, built, clock, logs, watcher };
}

describe("releasable", () => {
  it.each([
    ["at the end of the window", {}, DUE, true],
    ["one millisecond before the window ends", {}, DUE - 1, false],
    ["an escrow of another supplier", { supplier_pkh: OTHER.pubKeyHash }, DUE, false],
    ["an escrow of another agent", { agent_id: OTHER_AGENT_ID }, DUE, false],
    ["an escrow that is Open", { state: "Open" as const, submitted_at: null }, DUE, false],
    ["an escrow that is Claimed", { state: "Claimed" as const, submitted_at: null }, DUE, false],
    ["a Submitted escrow with no submitted_at", { submitted_at: null }, DUE, false],
  ])("%s", (_name, changes, now, expected) => {
    expect(releasable(submitted(changes), owner, now)).toBe(expected);
  });

  it("never releases an escrow that names an agent when the node has none", () => {
    expect(releasable(submitted(), { ...owner, agentId: null }, DUE)).toBe(false);
  });

  it("checks no agent for a legacy escrow", () => {
    const { agent_id: _agent, refund: _refund, ...legacy } = submitted();
    expect(releasable(legacy, { ...owner, agentId: null }, DUE)).toBe(true);
  });
});

describe("the release watcher", () => {
  it("releases the Submitted escrows of this node after the window, with the real builder", async () => {
    const chain = new MockChainProvider();
    chain.advanceSlot(10_000);
    const a = refOf(1);
    const b = refOf(2);
    const { watcher } = setup({
      chain,
      now: 10_000_000,
      useRealBuilder: true,
      escrows: [
        { ref: a, datum: submitted(), layout: "identity" },
        { ref: b, datum: submitted(), layout: "legacy" },
      ],
    });

    const result = await watcher.tick();

    expect(result.released.sort()).toEqual([text(a), text(b)].sort());
    expect(await chain.queryUtxo(a)).toBeNull();
    expect(await chain.queryUtxo(b)).toBeNull();
  });

  it("asks for no Release before the window ends, and asks once it has ended", async () => {
    const ref = refOf(3);
    const { watcher, built, clock } = setup({ now: DUE - 1, escrows: [{ ref, datum: submitted(), layout: "identity" }] });

    expect((await watcher.tick()).released).toEqual([]);
    expect(built).not.toHaveBeenCalled();

    clock.now = DUE;
    expect((await watcher.tick()).released).toEqual([text(ref)]);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it("releases only its own escrow among foreign ones, an unfinished one and one of another agent", async () => {
    const own = refOf(4);
    const { watcher, built } = setup({
      escrows: [
        { ref: refOf(5), datum: submitted({ supplier_pkh: OTHER.pubKeyHash }), layout: "identity" },
        { ref: refOf(6), datum: submitted({ agent_id: OTHER_AGENT_ID }), layout: "identity" },
        { ref: refOf(7), datum: submitted({ state: "Claimed", submitted_at: null }), layout: "identity" },
        { ref: own, datum: submitted(), layout: "identity" },
      ],
    });

    const result = await watcher.tick();

    expect(result.released).toEqual([text(own)]);
    expect(built).toHaveBeenCalledTimes(1);
    expect(built.mock.calls[0]![0].escrowRef).toEqual(own);
  });

  it("does not read an escrow of the other layout at an address", async () => {
    const { watcher, built } = setup({
      escrows: [
        { ref: refOf(8), datum: submitted(), layout: "legacy", at: "identity" },
        { ref: refOf(9), datum: submitted(), layout: "identity", at: "legacy" },
      ],
    });

    await watcher.tick();

    expect(built).not.toHaveBeenCalled();
  });

  it("gives the identity blueprint to the builder for an escrow that names an agent only", async () => {
    const { watcher, built } = setup({
      escrows: [
        { ref: refOf(10), datum: submitted(), layout: "identity" },
        { ref: refOf(11), datum: submitted(), layout: "legacy" },
      ],
    });

    await watcher.tick();

    const params = built.mock.calls.map(([p]) => p);
    expect(params.find((p) => p.escrowRef.txHash === refOf(10).txHash)!.identityBlueprint).toBe(IDENTITY);
    expect(params.find((p) => p.escrowRef.txHash === refOf(11).txHash)!.identityBlueprint).toBeUndefined();
  });

  it("reads the escrow again under the wallet lock, and skips one that the buyer accepted meanwhile", async () => {
    const ref = refOf(12);
    const { watcher, built, state, chain } = setup({ escrows: [{ ref, datum: submitted(), layout: "identity" }] });
    const read = vi.spyOn(chain, "queryUtxosByAddress");
    let unlock: () => void = () => undefined;
    const held = state.walletMutex.run(() => new Promise<void>((resolve) => { unlock = resolve; }));

    const pending = watcher.tick();
    // Wait until the scan has found the escrow and the watcher waits for the lock.
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setImmediate(resolve));
    // The buyer accepts: the escrow output is spent while the watcher waits for the lock.
    await chain.submitTx(MockChainProvider.buildTestTx({ inputs: [ref] }));
    unlock();
    await held;
    const result = await pending;

    expect(built).not.toHaveBeenCalled();
    expect(result).toEqual({ released: [], skipped: 1, failed: [] });
  });

  it("does not try an escrow again within the retry time after a failure, and tries again after it", async () => {
    const ref = refOf(13);
    const { watcher, built, clock } = setup({ escrows: [{ ref, datum: submitted(), layout: "identity" }] });
    built.mockRejectedValue(new Error("no collateral"));

    expect((await watcher.tick()).failed).toEqual([text(ref)]);
    expect(await watcher.tick()).toEqual({ released: [], skipped: 1, failed: [] });
    expect(built).toHaveBeenCalledTimes(1);

    clock.now += RELEASE_RETRY_MS;
    expect((await watcher.tick()).failed).toEqual([text(ref)]);
    expect(built).toHaveBeenCalledTimes(2);
  });

  it("goes on with the next escrow after a failed Release", async () => {
    const first = refOf(14);
    const second = refOf(15);
    const { watcher, built } = setup({
      escrows: [
        { ref: first, datum: submitted(), layout: "identity" },
        { ref: second, datum: submitted(), layout: "identity" },
      ],
    });
    built.mockRejectedValueOnce(new Error("no collateral"));

    const result = await watcher.tick();

    expect(result.failed).toHaveLength(1);
    expect(result.released).toHaveLength(1);
    expect(built).toHaveBeenCalledTimes(2);
  });

  it("logs a scan that fails, and the tick does not throw", async () => {
    const { watcher, chain, logs } = setup();
    chain.queryUtxosByAddress = async () => {
      throw new Error("node down");
    };

    await expect(watcher.tick()).resolves.toEqual({ released: [], skipped: 0, failed: [] });
    expect(logs.some((line) => line.includes("node down"))).toBe(true);
  });

  it("does not start a tick while another one runs", async () => {
    const ref = refOf(16);
    const { watcher, built } = setup({ escrows: [{ ref, datum: submitted(), layout: "identity" }] });
    let finish: () => void = () => undefined;
    built.mockImplementation(() => new Promise<BuildResult>((resolve) => {
      finish = () => resolve({ txCborHex: "00", expectedTxHash: "7".repeat(64) });
    }));

    const first = watcher.tick();
    await vi.waitFor(() => expect(built).toHaveBeenCalledTimes(1));
    expect(await watcher.tick()).toEqual({ released: [], skipped: 0, failed: [] });
    finish();
    expect((await first).released).toEqual([text(ref)]);
    expect(built).toHaveBeenCalledTimes(1);
  });

  it("takes the agent from the advert when AGENT_ID is not set, and none when the advert cannot be read", async () => {
    const advert: IdentityAdvertDatum = {
      supplier_pkh: SUPPLIER.pubKeyHash, capability_id: "x.y.v1", model: "m", max_output_tokens: 1, max_processing_ms: 1,
      price_lovelace: 1n, supplier_bond_lovelace: 0n, buyer_bond_lovelace: 0n, endpoint_url: "https://a.example", detail_uri: "",
      detail_hash: "a".repeat(64), advertised_at: 0, status: "Active", agent_id: AGENT_ID,
    };
    const ref = refOf(17);
    const withAdvert = setup({ agentId: undefined, escrows: [{ ref, datum: submitted(), layout: "identity" }] });
    withAdvert.chain.seed({
      ref: ADVERT_REF, address: IDENTITY.advertScriptAddress(0), lovelace: 2_000_000n, assets: {},
      datumHex: encodeIdentityAdvertDatum(advert), scriptRef: null,
    });
    expect((await withAdvert.watcher.tick()).released).toEqual([text(ref)]);

    const withoutAdvert = setup({ agentId: undefined, escrows: [{ ref, datum: submitted(), layout: "identity" }] });
    expect((await withoutAdvert.watcher.tick()).released).toEqual([]);
    expect(withoutAdvert.built).not.toHaveBeenCalled();
  });

  it("looks each minute, and stops when it is stopped", async () => {
    vi.useFakeTimers();
    const chain = new MockChainProvider();
    const read = vi.spyOn(chain, "queryUtxosByAddress");
    const { watcher } = setup({ chain });
    expect(RELEASE_WATCH_INTERVAL_MS).toBe(60_000);

    await vi.advanceTimersByTimeAsync(RELEASE_WATCH_INTERVAL_MS - 1);
    expect(read).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(2);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(10 * RELEASE_WATCH_INTERVAL_MS);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("maybeStartReleaseWatcher", () => {
  const deps = () => {
    const chain = new MockChainProvider();
    return { chain, deps: { chain, state: new SupplierState(1), supplierKey: SUPPLIER, identity: supplierIdentity(chain, 0, { blueprint: IDENTITY }) } };
  };
  const config = { agentId: AGENT_ID, advertRef: ADVERT_REF, networkId: 0 as const };

  it("starts nothing when the setting is off", async () => {
    vi.useFakeTimers();
    const { chain, deps: d } = deps();
    const read = vi.spyOn(chain, "queryUtxosByAddress");

    expect(maybeStartReleaseWatcher({ ...config, releaseWatcher: false }, d)).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * RELEASE_WATCH_INTERVAL_MS);

    expect(read).not.toHaveBeenCalled();
  });

  it("starts the watcher when the setting is on", async () => {
    vi.useFakeTimers();
    const { chain, deps: d } = deps();
    const read = vi.spyOn(chain, "queryUtxosByAddress");

    const watcher = maybeStartReleaseWatcher({ ...config, releaseWatcher: true }, d);
    expect(watcher).not.toBeNull();
    watchers.push(watcher!);
    await vi.advanceTimersByTimeAsync(RELEASE_WATCH_INTERVAL_MS);

    expect(read).toHaveBeenCalled();
  });
});
