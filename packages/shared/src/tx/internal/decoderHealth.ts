/**
 * tx/internal/decoderHealth.ts — the health of the decoder library in a process.
 *
 * A process that loads the decoder library (CML, through Lucid) calls `startDecoderHealth` once, after the library is loaded. After
 * that the process, after each HTTP request and on a timer of 1 s:
 *   1. puts the stack pointer of the library back to its start value when it is lower (restoreStackPointer), and
 *   2. asks the library to decode one known value (decoderWorks).
 * When the library cannot decode, the process writes one line and starts its normal shutdown (`stop`: the path that a SIGTERM takes,
 * with its drain logic), so that its supervisor starts it again.
 *
 * The check does not look at the error of a call. Lucid and the builders catch errors of the library and give others, so the error
 * that reaches the end of a call does not say that the library is the cause.
 *
 * When no failure happens, nothing changes and nothing is written.
 *
 * The restore is safe at any moment at which no call into the library is on the JavaScript stack: all calls into the library are
 * synchronous, so the end of a request and a timer are such moments. It puts only the pointer back. It does not give back other
 * memory that a failed call took, so the self-check and the stop stay the last line. The self-check covers the decoder library
 * only, not the script evaluator of Lucid, which is a separate WebAssembly instance.
 */

import type { Server } from "node:http";
import { CML } from "@lucid-evolution/lucid";

/** A value that every working decoder decodes: Plutus data, constructor 0 with no fields. */
const KNOWN_VALUE = "d87980";
const STOP_LINE = "The decoder library cannot decode a known value. The process stops so that its supervisor starts it again.";
const DEFAULT_INTERVAL_MS = 1000;

/** What the health check needs of the decoder library. `CML` is the default; a test passes a stand-in. */
export interface DecoderLibrary {
  /** The WebAssembly instance of the library, when its build exports it. */
  __wasm?: unknown;
  PlutusData: { from_cbor_hex(hex: string): { free(): void } };
}

/** The self-check: does the decoder library decode a known value? */
export function decoderWorks(library: DecoderLibrary = CML): boolean {
  try {
    library.PlutusData.from_cbor_hex(KNOWN_VALUE).free();
    return true;
  } catch {
    return false;
  }
}

/** The function of the decoder library that moves its stack pointer by a number of bytes and returns the new value. */
type MoveStackPointer = (delta: number) => number;
let moveStackPointer: MoveStackPointer | undefined;
let stackStart: number | undefined;

/**
 * Starts to watch the stack pointer of the decoder library: reads it two times, and keeps the value as the start value when the two
 * reads agree. The process calls it once, after the library is loaded and while no call into the library is in progress. Returns
 * false, and watches nothing, when `library` (CML by default) has no such export, as another build of the library may have none, or
 * the reads differ.
 */
export function watchStackPointer(library: object = CML): boolean {
  moveStackPointer = undefined;
  stackStart = undefined;
  const instance: unknown = Reflect.get(library, "__wasm");
  if (typeof instance !== "object" || instance === null) return false;
  const move: unknown = Reflect.get(instance, "__wbindgen_add_to_stack_pointer");
  if (typeof move !== "function") return false;
  const read = (delta: number): number => {
    const value: unknown = Reflect.apply(move, instance, [delta]);
    return typeof value === "number" ? value : NaN;
  };
  const first = read(0);
  if (!Number.isInteger(first) || first !== read(0)) return false;
  moveStackPointer = read;
  stackStart = first;
  return true;
}

/** Stops the watch of the stack pointer. */
export function unwatchStackPointer(): void {
  moveStackPointer = undefined;
  stackStart = undefined;
}

/**
 * When a stack pointer is watched and is below its start value, puts it back to the start value, reads it again, and writes one line
 * with the difference. A pointer at the start value is not touched, and one above it is not touched either: the self-check decides.
 * It runs before the self-check, so a call that left the pointer low does not stop a process whose library works again.
 */
export function restoreStackPointer(): void {
  if (moveStackPointer === undefined || stackStart === undefined) return;
  try {
    const now = moveStackPointer(0);
    if (!(now < stackStart)) return;
    moveStackPointer(stackStart - now);
    const confirmed = moveStackPointer(0) === stackStart;
    console.error(
      `The stack pointer of the decoder library was ${stackStart - now} bytes below its start value. ` +
        `${confirmed ? "The process put it back." : "The process could not put it back."}`,
    );
  } catch {
    // The self-check decides.
  }
}

/** The exit code of a process that the check stopped. */
export const DECODER_EXIT_CODE = 1;

export interface DecoderHealthOptions {
  /** The HTTP server of the process: the check runs after each request on it ends. */
  server: Server;
  /**
   * Starts the normal shutdown of the process (the path that a SIGTERM takes) and ends it with `exitCode`. It is called at most one
   * time, after the self-check failed. It returns false, and starts nothing, when the process is already shutting down.
   */
  stop: (exitCode: number) => boolean;
  /**
   * The time in ms that the normal shutdown may take. When it has not ended by then, the process ends itself with exit code 1.
   * Docker gives a stop of the service this time (`stop_grace_period` in its compose file, 10 s when the file has none); a shutdown
   * that the check starts has no stop of Docker behind it. Each process names its value next to the compose value.
   */
  stopLimitMs: number;
  /** The decoder library. Default: CML. */
  library?: DecoderLibrary;
  /** Milliseconds between two checks on the timer. Default: 1000. */
  intervalMs?: number;
}

export interface DecoderHealth {
  /** Puts the stack pointer back, then runs the self-check. It stops the process, one time, when the self-check fails. */
  check(): void;
  /** Stops the timer and the watch of the stack pointer. Later checks do nothing. */
  close(): void;
  /** False when the library has no stack pointer to watch: only the self-check runs then. */
  readonly watchesStackPointer: boolean;
}

/**
 * Starts the watch of the stack pointer, the check after each request on `server`, and the check on a timer of 1 s (the timer does
 * not keep the process alive). Call it once, after the library is loaded.
 */
export function startDecoderHealth(options: DecoderHealthOptions): DecoderHealth {
  const library = options.library ?? CML;
  const watching = watchStackPointer(library);
  let closed = false;
  let stopping = false;

  const check = (): void => {
    if (closed) return;
    restoreStackPointer();
    if (stopping || decoderWorks(library)) return;
    stopping = true;
    console.error(STOP_LINE);
    try {
      if (options.stop(DECODER_EXIT_CODE)) {
        const limit = setTimeout(() => {
          console.error(`The shutdown did not end in ${options.stopLimitMs} ms. The process ends now.`);
          process.exit(DECODER_EXIT_CODE);
        }, options.stopLimitMs);
        limit.unref();
      }
    } catch (error) {
      console.error(`The shutdown of the process failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  options.server.on("request", (_request, response) => {
    response.once("close", check);
  });
  const timer = setInterval(check, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  timer.unref();

  return {
    check,
    close: () => {
      closed = true;
      clearInterval(timer);
      unwatchStackPointer();
    },
    watchesStackPointer: watching,
  };
}
