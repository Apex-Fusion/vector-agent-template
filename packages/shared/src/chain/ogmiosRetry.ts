/**
 * ogmiosRetry — try a read-only Ogmios HTTP request again after a transient error.
 *
 * The public Ogmios endpoint (behind Cloudflare) answers HTTP 500 for a few
 * seconds now and then. One such answer must not fail a paid job.
 *
 * The rule:
 *   1. A request is READ-ONLY when its JSON-RPC method is not
 *      `submitTransaction`. So `queryLedgerState/*`, `queryNetwork/*` and
 *      `evaluateTransaction` are read-only.
 *   2. A read-only request has at most 3 tries in total. Try 2 and try 3 start
 *      only when the try before ended with:
 *        - an HTTP status of 500 or higher (this includes the Cloudflare 52x
 *          codes), or
 *        - a `fetch` that rejects with a network error (for example
 *          `TypeError: fetch failed`, or a connection reset).
 *   3. There is NO new try when:
 *        - the HTTP status is below 500 (a 400 with a JSON-RPC error body is a
 *          real answer), or
 *        - the try ended by its timeout or by an abort (`TimeoutError`,
 *          `AbortError`): a new try would make the worst-case time of a call
 *          much longer, or
 *        - the answer is HTTP 200. The caller reads the body after this
 *          function returns, so a JSON-RPC `error` and a malformed body never
 *          reach this code: they are real answers, not transient errors.
 *   4. `submitTransaction` has exactly ONE try, for every error. A submit that
 *      got no clear answer may be on chain. A second submit of the same
 *      transaction fails with a misleading error (its inputs are spent), and
 *      the caller then treats a transaction that is on chain as failed.
 *      The submit code paths do not call this function. The method check below
 *      is a second guard in case one of them does one day.
 *   5. Wait 300 ms before try 2 and 1,000 ms before try 3. Each try gets a
 *      fresh timeout signal (an `AbortSignal.timeout` cannot be used twice).
 *      The request body is the same string on each try.
 *   6. After the last try, the function returns the last response (the caller
 *      then throws its usual HTTP error) or throws the last error unchanged.
 *      So the caller sees the same error class and the same text as it saw
 *      before this code existed.
 *   7. Each retry writes ONE line with `console.warn`:
 *        [ogmios] retry <n>/2 method=<method> cause=<http status | error class name>
 *      Nothing else: no URL (it can hold a credential), no body, no params.
 */

/** Wait before try 2 and before try 3, in ms. So a read-only request has 3 tries in total. */
const RETRY_WAITS_MS = [300, 1_000] as const;

/** The only JSON-RPC method that changes the chain. It is never tried again. */
const SUBMIT_METHOD = "submitTransaction";

export interface FetchOgmiosReadArgs {
  /** The fetch to call. The caller resolves it at call time. */
  fetch: typeof globalThis.fetch;
  url: string;
  /** JSON-RPC method of the request. It decides read-only or submit, and it goes in the warn line. */
  method: string;
  /** The request body. The same string goes out on each try. */
  body: string;
  /** Timeout of ONE try. Each try has its own `AbortSignal.timeout`. */
  timeoutMs: number;
  /** The wait before a new try. Tests inject it. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * POST `body` to Ogmios with the retry rule above. Returns the response of the
 * last try, whatever its status: the caller checks `response.ok` as before.
 */
export async function fetchOgmiosRead(args: FetchOgmiosReadArgs): Promise<Response> {
  const { fetch: fetcher, url, method, body, timeoutMs } = args;
  const sleep = args.sleep ?? timerSleep;
  const maxRetries = method === SUBMIT_METHOD ? 0 : RETRY_WAITS_MS.length;

  for (let retry = 0; ; retry += 1) {
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    };
    // AbortSignal.timeout is widely supported in Node 18+; guard for environments
    // where it may not exist (some test mocks). One signal serves one try only.
    if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
      init.signal = AbortSignal.timeout(timeoutMs);
    }

    // Only the fetch call is inside the try block: an error from the code
    // below (a broken response object) is not a network error.
    let response: Response;
    try {
      response = await fetcher(url, init);
    } catch (err) {
      if (retry === maxRetries || endedByTimeoutOrAbort(err, init.signal)) throw err;
      await waitBeforeRetry(retry + 1, method, errorClassName(err), sleep);
      continue;
    }
    // The check is `!(status >= 500)` on purpose: an answer with no numeric
    // status (a test mock) is an answer, not a 5xx. `status < 500` would try it again.
    if (retry === maxRetries || !(response.status >= 500)) return response;
    // This answer is dropped: release its connection before the next try.
    await dropBody(response);
    await waitBeforeRetry(retry + 1, method, String(response.status), sleep);
  }
}

async function waitBeforeRetry(
  retry: number,
  method: string,
  cause: string,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  // eslint-disable-next-line no-console
  console.warn(`[ogmios] retry ${retry}/${RETRY_WAITS_MS.length} method=${method} cause=${cause}`);
  await sleep(RETRY_WAITS_MS[retry - 1]);
}

/** Cancel the body of an answer that this code drops. A fetch body that nobody reads or cancels holds its connection. */
async function dropBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The answer is dropped anyway: a body that cannot be cancelled changes nothing.
  }
}

/** True when the try ended by its timeout or by an abort. */
function endedByTimeoutOrAbort(err: unknown, signal: AbortSignal | null | undefined): boolean {
  if (signal?.aborted) return true;
  if (typeof err !== "object" || err === null || !("name" in err)) return false;
  return err.name === "TimeoutError" || err.name === "AbortError";
}

/** The class name of a thrown value, for the warn line. It holds no message, URL or body. */
function errorClassName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const name: unknown = err.constructor?.name;
    if (typeof name === "string" && name !== "") return name;
  }
  return typeof err;
}

function timerSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
