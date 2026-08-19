/**
 * walletHealth.ts — Periodic + on-failure wallet auto-consolidation.
 *
 * The supplier wallet drifts into a fragmented shape over time as Claim/
 * Submit/Accept change outputs accumulate. Once a dust UTxO becomes the
 * coin-selected working input, buildClaimTx fails with `chain_submit_failed`
 * and the lane stalls until an operator runs `tx:consolidate-wallet`.
 *
 * Two layers of self-healing:
 *   startWalletHealthTicker — periodic background tick (every N ms). Runs
 *     runConsolidateWallet; planConsolidate's structural health predicate
 *     short-circuits without a tx when a collateral candidate exists and
 *     fragmentation is bounded. A tick on a healthy wallet costs one UTxO
 *     query and nothing else.
 *   triggerOnFailureConsolidate — fire-and-forget consolidate from the
 *     Claim-failure path. Debounced so back-to-back failures don't queue
 *     multiple consolidates. Returns 503 to the buyer for THIS request; the
 *     next buyer retry (~30-60s later) finds the wallet healthy.
 *
 * F7 guards (2026-08-08 incident: a non-idempotent health check made every
 * tick consolidate, burning 0.5 AP3X per 45s until the wallet hit the
 * floor — 116 AP3X in one soak). Two independent circuit breakers protect
 * against ANY future non-convergence:
 *   - consecutive guard: 3 consolidations in a row without ever reaching
 *     `already-healthy` halts wallet-health for this process.
 *   - budget guard: more than 6 consolidations inside 24h halts it too.
 * A halt logs loudly once; consolidate manually and restart the supplier
 * to re-arm.
 *
 * Wallet-lock discipline: consolidation spends EVERY wallet UTxO, so it runs
 * inside state.walletMutex — the same mutex that serializes Claims/Submits —
 * queueing behind any in-flight chain op instead of skipping. Session slots
 * are not consumed: consolidation is a wallet op, not a session.
 */

import type { ChainProvider } from "@marketplace/shared/chain";
import type { WalletKey } from "@marketplace/shared/tx";
import {
  runConsolidateWallet,
  type ConsolidateWalletFlowParams,
  type ConsolidateWalletFlowResult,
} from "@marketplace/shared/tx/server";

import type { SupplierState } from "./state.js";

const DEFAULT_COLLATERAL_LOVELACE = 5_000_000n;
const DEFAULT_AWAIT_TIMEOUT_MS = 90_000;
const DEFAULT_ON_FAILURE_DEBOUNCE_MS = 5 * 60_000;

export type ConsolidateFn = (
  params: ConsolidateWalletFlowParams,
) => Promise<ConsolidateWalletFlowResult>;

export interface WalletHealthDeps {
  chain: ChainProvider;
  state: SupplierState;
  supplierKey: WalletKey;
  /** Test-injectable. Defaults to runConsolidateWallet from @marketplace/shared. */
  consolidate?: ConsolidateFn;
}

export interface WalletHealthOptions {
  intervalMs: number;
  collateralLovelace?: bigint;
  awaitTimeoutMs?: number;
  /** Override for tests; defaults to console.log. */
  log?: (line: string) => void;
}

export interface WalletHealthTicker {
  stop(): void;
}

const inFlight = new WeakSet<SupplierState>();
const lastOnFailureAt = new WeakMap<SupplierState, number>();

// ── F7 circuit breakers ──────────────────────────────────────────────
const MAX_CONSECUTIVE_CONSOLIDATIONS = 3;
const MAX_CONSOLIDATIONS_PER_WINDOW = 6;
const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

interface GuardCounters {
  consecutive: number;
  windowStart: number;
  windowCount: number;
  halted: boolean;
}

const guardCounters = new WeakMap<SupplierState, GuardCounters>();

function guardsFor(state: SupplierState): GuardCounters {
  let g = guardCounters.get(state);
  if (!g) {
    g = { consecutive: 0, windowStart: Date.now(), windowCount: 0, halted: false };
    guardCounters.set(state, g);
  }
  return g;
}

function defaultLog(line: string): void {
  // eslint-disable-next-line no-console
  console.log(`[wallet-health] ${line}`);
}

async function consolidateOnce(
  deps: WalletHealthDeps,
  opts: { collateralLovelace: bigint; awaitTimeoutMs: number; log: (line: string) => void },
): Promise<void> {
  const { state } = deps;
  const guards = guardsFor(state);
  if (guards.halted) return; // the halt already logged loudly, once
  if (inFlight.has(state)) {
    opts.log("skip: another consolidate already in flight");
    return;
  }
  inFlight.add(state);
  const consolidate: ConsolidateFn = deps.consolidate ?? runConsolidateWallet;
  try {
    // Queue behind any in-flight Claim/Submit — consolidation reshapes the
    // whole wallet and must never race another wallet spend.
    const result = await state.walletMutex.run(() =>
      consolidate({
        chain: deps.chain,
        walletKey: deps.supplierKey,
        collateralLovelace: opts.collateralLovelace,
        awaitTimeoutMs: opts.awaitTimeoutMs,
        log: opts.log,
      }),
    );
    if (result.reason === "already-healthy") {
      guards.consecutive = 0;
      opts.log("already-healthy");
    } else {
      const now = Date.now();
      if (now - guards.windowStart > BUDGET_WINDOW_MS) {
        guards.windowStart = now;
        guards.windowCount = 0;
      }
      guards.consecutive += 1;
      guards.windowCount += 1;
      opts.log(`consolidated: ${result.reason} txHash=${result.txHash}`);
      if (guards.consecutive >= MAX_CONSECUTIVE_CONSOLIDATIONS) {
        guards.halted = true;
        opts.log(
          `HALT: ${guards.consecutive} consecutive consolidations without reaching a healthy shape — ` +
            `wallet-health stopped to protect funds (F7 guard). Investigate planConsolidate vs the ` +
            `builder's output shape, consolidate manually, restart the supplier to re-arm.`,
        );
      } else if (guards.windowCount >= MAX_CONSOLIDATIONS_PER_WINDOW) {
        guards.halted = true;
        opts.log(
          `HALT: consolidation budget exhausted (${guards.windowCount} in 24h) — wallet-health ` +
            `stopped to protect funds (F7 guard). Restart the supplier to re-arm.`,
        );
      }
    }
  } catch (err) {
    // Neither healthy nor consolidated (e.g. balance too low): no fee was
    // spent, so the guards don't move — but nothing converged either, so
    // the consecutive counter is NOT reset.
    opts.log(`consolidate failed: ${(err as Error).message}`);
  } finally {
    inFlight.delete(state);
  }
}

export function startWalletHealthTicker(
  deps: WalletHealthDeps,
  opts: WalletHealthOptions,
): WalletHealthTicker {
  const collateralLovelace = opts.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE;
  const awaitTimeoutMs = opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS;
  const log = opts.log ?? defaultLog;

  const handle = setInterval(() => {
    void consolidateOnce(deps, { collateralLovelace, awaitTimeoutMs, log });
  }, opts.intervalMs);
  handle.unref();

  return {
    stop(): void {
      clearInterval(handle);
    },
  };
}

export function triggerOnFailureConsolidate(
  deps: WalletHealthDeps,
  opts: Partial<WalletHealthOptions> & { debounceMs?: number } = {},
): void {
  const { state } = deps;
  const debounceMs = opts.debounceMs ?? DEFAULT_ON_FAILURE_DEBOUNCE_MS;
  const now = Date.now();
  const last = lastOnFailureAt.get(state) ?? 0;
  if (now - last < debounceMs) return;
  lastOnFailureAt.set(state, now);

  const log = opts.log ?? defaultLog;
  log("on-failure trigger: scheduling consolidate");
  void consolidateOnce(deps, {
    collateralLovelace: opts.collateralLovelace ?? DEFAULT_COLLATERAL_LOVELACE,
    awaitTimeoutMs: opts.awaitTimeoutMs ?? DEFAULT_AWAIT_TIMEOUT_MS,
    log,
  });
}

/** Test-only: reset the in-flight + debounce + guard maps between tests. */
export function _resetWalletHealthForTests(state: SupplierState): void {
  inFlight.delete(state);
  lastOnFailureAt.delete(state);
  guardCounters.delete(state);
}
