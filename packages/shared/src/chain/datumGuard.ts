/**
 * chain/datumGuard.ts — the check at the boundary of the Ogmios clients.
 *
 * A client refuses CBOR that is nested deeper than 64 levels before it is decoded (cbor-depth.ts). It checks two things in the answer
 * of Ogmios, and both stay on chain, so the client sees them again at each read:
 *
 * - Both clients: an inline datum that fails the check is WITHHELD. The output stays in the list with its address, its value and its
 *   other fields, and it has no datum. Its value still counts. A key address needs no datum to be spent. A caller that reads the
 *   datum of an output at a script address finds none, and refuses the output as it refuses an output with no datum.
 * - The Lucid client only (OgmiosLucidProvider): a native script that fails the check LEAVES THE OUTPUT OUT of the answer. That
 *   client hands the script to Lucid, and Lucid asks a fee for the reference script of each output that it spends. A transaction
 *   that does not count the script gets a fee that is too low, and the node refuses it. An output with a withheld datum stays in the
 *   list, because a datum costs no fee.
 *
 * The read-only client (ReadOnlyOgmiosProvider, and LiveOgmiosProvider through it) maps no native script, so it never leaves an output
 * out. For its callers an output that is absent from an answer is an output that the node does not list: spent. Nothing else may make
 * an output absent there.
 *
 * A Plutus script is opaque bytes and needs no check.
 *
 * Both clients also bound the texts that the library reads when Lucid spends an output: the address, the transaction id, the policy
 * ids and the asset names (assertOutputFields). The ledger fixes the size of each, so a longer text means a broken node. The whole call
 * fails with an OutputFieldError, as for any other error of the node. No output becomes absent because of it.
 *
 * A datum is withheld for one reason only: the datum itself fails the check. The check has no limit for the number of outputs, for the
 * size of one answer, or for the length of a text. Any wallet can send an output with an inline datum to any address, so a limit for
 * one answer would let a third party add outputs before the record or the escrow that a reader looks for. The reader would find that
 * output with no datum, although the datum is valid. The scan is linear in the text that the client has already read and parsed: about
 * 2 ns for each character and a few microseconds for each datum.
 *
 * The log is bounded, and the bound never changes what a reader gets:
 * - Memory. An answer keeps at most 20 new references for its lines, and counts the others.
 * - Lines. An answer writes at most 20 lines for new references, and one summary line for each address that has more. After a
 *   summary line an address writes nothing for one hour (SILENT_MS); the process remembers at most 100 such addresses, oldest out
 *   first. So an address that holds 100,000 bad outputs writes 21 lines in an hour, however often it is read.
 * - The log never holds the bytes. It has one line for each output reference, one time: the process remembers the last 1,000
 *   references that it reported (all clients share the memory, because a new client is built for each transaction).
 */

import { assertCborHexDepth } from "../cbor-depth.js";

/** The references that the process remembers as reported. */
export const REMEMBERED_REFS_MAX = 1000;
/** The new references that one answer keeps for its lines. */
export const LINES_PER_ANSWER_MAX = 20;
/** The addresses that the process remembers as silent. */
export const SILENT_ADDRESSES_MAX = 100;
/** How long an address stays silent after its summary line (ms). */
export const SILENT_MS = 60 * 60 * 1000;

/** The longest address text of an output, in characters. A real address has at most 108; this is the bound of `checkedAddressText`. */
export const MAX_OUTPUT_ADDRESS_LENGTH = 1024;
/** The ledger fixes a transaction id at 32 bytes, a policy id at 28 bytes and an asset name at 32 bytes at most (hex characters). */
export const MAX_TX_ID_LENGTH = 64;
export const MAX_POLICY_ID_LENGTH = 56;
export const MAX_ASSET_NAME_LENGTH = 64;

/** Thrown when a field of an output is longer than the ledger allows. The message gives the length, never the text. */
export class OutputFieldError extends Error {
  constructor(field: string, length: number, max: number) {
    super(`Ogmios sent an output whose ${field} is ${length} characters long; the longest ${field} is ${max} characters`);
    this.name = "OutputFieldError";
  }
}

/**
 * Refuses an output whose address, transaction id, policy id or asset name is longer than any value that the ledger allows. A
 * wallet or a script address cannot hold such an output, so a node that sends one is broken. The library reads these texts when
 * Lucid spends the output (the address with a quadratic cost), so the clients refuse the whole answer before they build any object
 * from it. A caller sees a failed call, as for any other error of the node, and never an absent output. The key `ada` of the value
 * and its key `lovelace` are within the bounds, so they need no special case. A field that is not a text is left to the mapper.
 */
export function assertOutputFields(o: { transaction: { id: string }; address: string; value?: object }): void {
  const id: unknown = o.transaction?.id;
  if (typeof id === "string" && id.length > MAX_TX_ID_LENGTH) throw new OutputFieldError("transaction id", id.length, MAX_TX_ID_LENGTH);
  const address: unknown = o.address;
  if (typeof address === "string" && address.length > MAX_OUTPUT_ADDRESS_LENGTH) {
    throw new OutputFieldError("address", address.length, MAX_OUTPUT_ADDRESS_LENGTH);
  }
  for (const [policyId, assets] of Object.entries(o.value ?? {})) {
    if (policyId.length > MAX_POLICY_ID_LENGTH) throw new OutputFieldError("policy id", policyId.length, MAX_POLICY_ID_LENGTH);
    if (assets === null || typeof assets !== "object") continue;
    for (const assetName of Object.keys(assets)) {
      if (assetName.length > MAX_ASSET_NAME_LENGTH) throw new OutputFieldError("asset name", assetName.length, MAX_ASSET_NAME_LENGTH);
    }
  }
}

/** The references that the process reported, oldest first. */
const reported = new Set<string>();
/** The addresses that wrote a summary line, with the time (ms) until which each stays silent, oldest first. */
const silent = new Map<string, number>();

/** Test only: forgets the references and the addresses that the process reported. */
export function resetGuardLogForTests(): void {
  reported.clear();
  silent.clear();
}

/** Remembers `ref`, and forgets the oldest reference when the memory is full. */
function remember(ref: string): void {
  reported.add(ref);
  if (reported.size > REMEMBERED_REFS_MAX) {
    const oldest = reported.values().next();
    if (!oldest.done) reported.delete(oldest.value);
  }
}

/** True while `address` is silent. A silence that ended is forgotten. */
function isSilent(address: string): boolean {
  const until = silent.get(address);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  silent.delete(address);
  return false;
}

/** Makes `address` silent for SILENT_MS, and forgets the oldest address when the memory is full. */
function silence(address: string): void {
  silent.delete(address);
  silent.set(address, Date.now() + SILENT_MS);
  if (silent.size > SILENT_ADDRESSES_MAX) {
    const oldest = silent.keys().next();
    if (!oldest.done) silent.delete(oldest.value);
  }
}

/** The address in a line: the node gives the text, so a long one is cut. */
const shortAddress = (address: string): string => (address.length > 120 ? `${address.slice(0, 120)}...` : address);

/** True when `cbor` (hex) passes the check of the depth and the form (cbor-depth.ts). */
function passes(cbor: string): boolean {
  // A refusal is an Error, and an Error takes a stack trace. The trace of a refusal is never read, and it costs more than the scan
  // of a small datum, so the scan runs with no trace.
  const traceLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 0;
  try {
    assertCborHexDepth(cbor);
    return true;
  } catch {
    return false;
  } finally {
    Error.stackTraceLimit = traceLimit;
  }
}

/** What one answer found: the outputs whose datum was withheld or whose script left the output out. */
export class WithheldOutputs {
  /** The new references of this answer that get a line, at most LINES_PER_ANSWER_MAX. */
  private readonly lines = new Map<string, "datum" | "script">();
  /** The new references beyond that, for each address: counted, not kept. At most LINES_PER_ANSWER_MAX addresses. */
  private readonly more = new Map<string, number>();
  /** The new references beyond that at other addresses. */
  private moreOthers = 0;

  /** The inline datum `datum` of the output `ref` at `address`, or null when it fails the check. The empty text is no datum and is kept as it is. */
  datum(datum: string, ref: string, address: string): string | null {
    if (datum.length === 0) return datum;
    if (passes(datum)) return datum;
    this.note(ref, "datum", address);
    return null;
  }

  /** True when the CBOR of the native script of the output `ref` at `address` passes the check. False: the output is left out of the answer. */
  nativeScriptReadable(cbor: string, ref: string, address: string): boolean {
    if (passes(cbor)) return true;
    this.note(ref, "script", address);
    return false;
  }

  private note(ref: string, kind: "datum" | "script", address: string): void {
    if (reported.has(ref) || isSilent(address)) return;
    if (this.lines.has(ref)) return;
    if (this.lines.size < LINES_PER_ANSWER_MAX) {
      this.lines.set(ref, kind);
      return;
    }
    const count = this.more.get(address);
    if (count !== undefined) this.more.set(address, count + 1);
    else if (this.more.size < LINES_PER_ANSWER_MAX) this.more.set(address, 1);
    else this.moreOthers += 1;
  }

  /**
   * Writes the lines for one answer: one for each new reference that it keeps, and one for each address that has more. An address
   * with a summary line is silent for the next hour. `client` names the client.
   */
  report(client: string): void {
    for (const [ref, kind] of this.lines) {
      remember(ref);
      // eslint-disable-next-line no-console
      console.warn(
        kind === "script"
          ? `[${client}] output ${ref}: its reference script is not read, so the output is left out of the answer`
          : `[${client}] output ${ref}: its datum is not read, so the output has no datum`,
      );
    }
    for (const [address, count] of this.more) {
      // eslint-disable-next-line no-console
      console.warn(
        `[${client}] ${count} more outputs at ${shortAddress(address)} carry a datum or a reference script that is not read; ` +
          `the address writes no more lines for one hour`,
      );
      silence(address);
    }
    // eslint-disable-next-line no-console
    if (this.moreOthers > 0) console.warn(`[${client}] ${this.moreOthers} more outputs at other addresses carry a datum or a reference script that is not read`);
  }
}
