/**
 * supplier/src/state.ts — In-process session-slot admission + wallet mutex.
 *
 * SupplierState admits up to `capacity` concurrent sessions (capacity 1 for
 * one-shot chat/tts kinds; MAX_CHAT_SESSIONS for chat-session kind). Status is
 * free-until-full: "working" only when every slot is taken, so the indexer
 * status poller and the buyer SDK's pre-check keep their existing semantics.
 * Cross-process coordination is M1-D; this is purely in-memory.
 *
 * walletMutex serializes every wallet-spending chain op (Claim/Submit/
 * consolidate): the wallet holds one working UTxO + one collateral UTxO, so
 * concurrent txs would double-spend regardless of how many session slots
 * exist. Hold it across build+awaitTx as one critical section.
 *
 * Invariants:
 *   - a ref can be held at most once (duplicate tryAcquire returns false)
 *   - release(ref) frees exactly that ref's slot
 *   - markOffline() clears all slots and refuses new acquires
 *   - snapshot.currentEscrowRef is present IFF status === "working" (legacy
 *     consumers; holds the oldest active ref)
 *   - lastSeenIso updates on every state-changing operation
 */

export type SupplierStatus = "free" | "working" | "offline";

/** Tiny promise-chain mutex: run(fn) executes fns strictly one at a time. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    // Keep the chain alive even if fn rejects; swallow here so the next
    // run() isn't poisoned by a prior rejection.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface SupplierSnapshot {
  status: SupplierStatus;
  /** Oldest active ref; present ONLY when status === "working" (back-compat). */
  currentEscrowRef?: string;
  activeEscrowRefs: string[];
  activeSessions: number;
  maxSessions: number;
  lastSeenIso: string;
}

export class SupplierState {
  /** Serializes ALL wallet-spending chain ops (Claim/Submit/consolidate). */
  readonly walletMutex = new Mutex();

  private readonly active = new Set<string>(); // insertion-ordered
  private offline = false;
  private lastSeenIso: string = new Date().toISOString();

  constructor(readonly capacity: number = 1) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`SupplierState: capacity must be a positive integer, got ${capacity}`);
    }
  }

  private touch(): void {
    // ISO 8601 with millisecond resolution. Coarse clocks may produce equal
    // values in tight succession — tests use >= rather than strict greater.
    this.lastSeenIso = new Date().toISOString();
  }

  tryAcquire(escrowRef: string): boolean {
    if (this.offline) return false;
    if (this.active.has(escrowRef)) return false;
    if (this.active.size >= this.capacity) return false;
    this.active.add(escrowRef);
    this.touch();
    return true;
  }

  release(escrowRef: string): void {
    if (this.active.delete(escrowRef)) {
      this.touch();
    }
  }

  markOffline(): void {
    this.offline = true;
    this.active.clear();
    this.touch();
  }

  snapshot(): SupplierSnapshot {
    const refs = [...this.active];
    const status: SupplierStatus = this.offline
      ? "offline"
      : refs.length >= this.capacity
        ? "working"
        : "free";
    const snap: SupplierSnapshot = {
      status,
      activeEscrowRefs: refs,
      activeSessions: refs.length,
      maxSessions: this.capacity,
      lastSeenIso: this.lastSeenIso,
    };
    // Omit currentEscrowRef key entirely when not working so
    // ('currentEscrowRef' in snap) === false (matches legacy consumers).
    if (status === "working" && refs.length > 0) {
      snap.currentEscrowRef = refs[0];
    }
    return snap;
  }
}
