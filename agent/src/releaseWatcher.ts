/**
 * agent/src/releaseWatcher.ts — the release watcher.
 *
 * A Submitted escrow that the buyer does not accept stays in the escrow
 * contract. After the accept window (600 seconds from the Submit), the supplier
 * can take it with the Release move: the quoted amount and both bonds settle to
 * the supplier. This watcher does that, so that no operator has to run
 * `tx:release-escrows` by hand.
 *
 * It runs only when RELEASE_WATCHER=1 (see runtimeSettings.ts). Each minute it:
 *   1. reads the escrow addresses (the legacy one, and the identity one when
 *      IDENTITY_POLICY_ID is set) and keeps the escrows that are Submitted and
 *      its own, and whose accept window has ended;
 *   2. releases them one at a time, with the Release builder of the core
 *      (buildReleaseTx), inside the wallet lock that the Claim and the Submit
 *      use. Under the lock it reads the escrow again, because the buyer can
 *      accept it between the scan and the lock.
 *
 * An escrow is its own when all of these hold:
 *   - its supplier key hash is the key hash of this node;
 *   - for an escrow that names an agent, the agent is the agent of this node
 *     (AGENT_ID, else the agent of the advert). The runtime works only such
 *     escrows, so it releases only such escrows;
 *   - it sits at the escrow address of its own layout.
 * The watcher never releases an escrow before its window ends. The core builder
 * and the contract check the window too.
 *
 * The watcher reads the chain, not the memory of the runtime, so it also
 * releases the escrows that were Submitted before a restart.
 */

import type { ChainProvider, OutputReference, Utxo } from "@marketplace/shared/chain";
import type { EscrowDatum } from "@marketplace/shared/cbor";
import {
  ACCEPT_WINDOW_MS,
  buildReleaseTx,
  isIdentityEscrowDatum,
  loadBlueprint,
  type BuildResult,
  type ReleaseParams,
  type WalletKey,
} from "@marketplace/shared/tx";

import type { SupplierConfig } from "./config.js";
import type { SupplierState } from "./state.js";
import { decodeAdvert, decodeEscrow, ownAgentId, type SupplierIdentity } from "./identity/agent.js";

/** How often the watcher looks for escrows to release. */
export const RELEASE_WATCH_INTERVAL_MS = 60_000;
/** How long the watcher waits for a Release to land. */
export const RELEASE_AWAIT_TIMEOUT_MS = 60_000;
/** After a Release that failed or did not land, the watcher leaves that escrow alone for this long. */
export const RELEASE_RETRY_MS = 5 * 60_000;

export interface ReleaseWatcherDeps {
  chain: ChainProvider;
  state: SupplierState;
  supplierKey: WalletKey;
  identity: SupplierIdentity;
  networkId: 0 | 1;
  /** AGENT_ID, or undefined: then the agent of the advert. */
  agentId: string | undefined;
  advertRef: OutputReference;
  /** The Release builder. Default: buildReleaseTx of the core. */
  buildRelease?: (params: ReleaseParams) => Promise<BuildResult>;
  /** The clock, in POSIX milliseconds. Default: Date.now. */
  now?: () => number;
}

export interface ReleaseWatcherOptions {
  intervalMs?: number;
  awaitTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface ReleaseTickResult {
  /** The escrows that the tick released: "<tx hash>#<index>". */
  released: string[];
  /** The escrows that were due and that the tick left alone. */
  skipped: number;
  /** The escrows whose Release failed. */
  failed: string[];
}

export interface ReleaseWatcher {
  stop(): void;
  /** One look at the chain. The timer calls it. It never throws. */
  tick(): Promise<ReleaseTickResult>;
}

export interface ReleaseOwner {
  supplierPkh: string;
  /** The agent of this node, or null when it has none. */
  agentId: string | null;
}

/**
 * True when the escrow is Submitted, is its own, and its accept window has
 * ended at `now`. The window ends at `submitted_at + 600 s`: the Release is
 * allowed from that time on.
 */
export function releasable(datum: EscrowDatum, owner: ReleaseOwner, now: number): boolean {
  if (datum.state !== "Submitted" || datum.submitted_at === null) return false;
  if (datum.supplier_pkh !== owner.supplierPkh) return false;
  if (isIdentityEscrowDatum(datum) && datum.agent_id !== owner.agentId) return false;
  return now >= datum.submitted_at + ACCEPT_WINDOW_MS;
}

const refText = (ref: OutputReference): string => `${ref.txHash}#${ref.index}`;
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The datum of an escrow output, or null when it has none or no decoder reads it. */
function escrowOf(utxo: Utxo): EscrowDatum | null {
  if (!utxo.datumHex) return null;
  try {
    return decodeEscrow(utxo.datumHex).datum;
  } catch {
    return null;
  }
}

export function startReleaseWatcher(deps: ReleaseWatcherDeps, opts: ReleaseWatcherOptions = {}): ReleaseWatcher {
  const now = deps.now ?? Date.now;
  const buildRelease = deps.buildRelease ?? buildReleaseTx;
  const awaitTimeoutMs = opts.awaitTimeoutMs ?? RELEASE_AWAIT_TIMEOUT_MS;
  const log = opts.log ?? ((line: string): void => console.log(`[release-watcher] ${line}`));
  /** The time of the last try for each escrow that was due. */
  const tried = new Map<string, number>();
  let running = false;

  /** The agent of this node: AGENT_ID, else the agent of the advert, else none. */
  async function ownAgent(): Promise<string | null> {
    if (deps.agentId !== undefined) return deps.agentId;
    try {
      const utxo = await deps.chain.queryUtxo(deps.advertRef);
      if (utxo !== null && utxo.datumHex) return ownAgentId(undefined, decodeAdvert(utxo.datumHex).datum);
    } catch {
      // The advert is not readable. The node has no agent for this tick.
    }
    return null;
  }

  /** The escrow addresses to read. The identity address needs the identity registry setting. */
  function escrowPlaces(): Array<{ address: string; identity: boolean }> {
    const places = [{ address: loadBlueprint().escrowScriptAddress(deps.networkId), identity: false }];
    try {
      places.push({ address: deps.identity.blueprint().escrowScriptAddress(deps.networkId), identity: true });
    } catch {
      // No identity registry is set up: the legacy address only.
    }
    return places;
  }

  /** The Release of one escrow, inside the wallet lock. Null when the escrow is not due any more. */
  async function releaseOne(ref: OutputReference, owner: ReleaseOwner): Promise<string | null> {
    // The buyer can accept the escrow between the scan and the lock, so read it again.
    const utxo = await deps.chain.queryUtxo(ref);
    const datum = utxo === null ? null : escrowOf(utxo);
    if (datum === null || !releasable(datum, owner, now())) return null;
    const built = await buildRelease({
      chain: deps.chain,
      supplierKey: deps.supplierKey,
      escrowRef: ref,
      ...(isIdentityEscrowDatum(datum) ? { identityBlueprint: deps.identity.blueprint() } : {}),
    });
    await deps.chain.awaitTx(built.expectedTxHash, awaitTimeoutMs);
    return built.expectedTxHash;
  }

  async function tick(): Promise<ReleaseTickResult> {
    const result: ReleaseTickResult = { released: [], skipped: 0, failed: [] };
    if (running) return result;
    running = true;
    try {
      for (const [key, when] of tried) {
        if (now() - when >= RELEASE_RETRY_MS) tried.delete(key);
      }
      const owner: ReleaseOwner = { supplierPkh: deps.supplierKey.pubKeyHash, agentId: await ownAgent() };
      const due: OutputReference[] = [];
      for (const place of escrowPlaces()) {
        let utxos: Utxo[];
        try {
          utxos = await deps.chain.queryUtxosByAddress(place.address);
        } catch (err) {
          log(`cannot read the escrows at ${place.address}: ${errorText(err)}`);
          continue;
        }
        const at = now();
        for (const utxo of utxos) {
          const datum = escrowOf(utxo);
          // An escrow of the other layout at this address is not one that this node works.
          if (datum === null || isIdentityEscrowDatum(datum) !== place.identity) continue;
          if (releasable(datum, owner, at)) due.push(utxo.ref);
        }
      }
      for (const ref of due) {
        const key = refText(ref);
        const last = tried.get(key);
        if (last !== undefined && now() - last < RELEASE_RETRY_MS) {
          result.skipped++;
          continue;
        }
        tried.set(key, now());
        try {
          const hash = await deps.state.walletMutex.run(() => releaseOne(ref, owner));
          if (hash === null) {
            result.skipped++;
          } else {
            tried.delete(key);
            result.released.push(key);
            log(`released ${key} tx=${hash}`);
          }
        } catch (err) {
          result.failed.push(key);
          log(`release of ${key} failed: ${errorText(err)}`);
        }
      }
    } catch (err) {
      log(`tick failed: ${errorText(err)}`);
    } finally {
      running = false;
    }
    return result;
  }

  const timer = setInterval(() => {
    void tick();
  }, opts.intervalMs ?? RELEASE_WATCH_INTERVAL_MS);
  timer.unref();
  return {
    stop(): void {
      clearInterval(timer);
    },
    tick,
  };
}

/**
 * Starts the watcher when RELEASE_WATCHER=1, and returns null when it is off.
 * index.ts calls this once at boot. With the setting off, nothing runs.
 */
export function maybeStartReleaseWatcher(
  config: Pick<SupplierConfig, "releaseWatcher" | "agentId" | "advertRef" | "networkId">,
  deps: Pick<ReleaseWatcherDeps, "chain" | "state" | "supplierKey" | "identity">,
  opts?: ReleaseWatcherOptions,
): ReleaseWatcher | null {
  if (!config.releaseWatcher) return null;
  return startReleaseWatcher(
    { ...deps, networkId: config.networkId, agentId: config.agentId, advertRef: config.advertRef },
    opts,
  );
}
