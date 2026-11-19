import {
  type Executor,
  type ExecutorJob,
  type ExecutorResult,
  type PrecheckJob,
  type PrecheckResult,
  ExecutorError,
} from "./executor.js";
import { contextHeaders } from "./context.js";

/** How long the runtime waits for the answer to the check before the Claim. */
export const PRECHECK_TIMEOUT_MS = 10_000;
/** The most bytes of the body of a refusal that the runtime reads. */
const PRECHECK_BODY_LIMIT = 8_192;
/** The most characters of the text of a refusal that the buyer gets. */
const PRECHECK_MESSAGE_LIMIT = 500;
/** A code is a plain word that a buyer can branch on. */
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export interface HttpCalloutOpts {
  serviceUrl: string;
  timeoutMs: number;
  authHeader?: string;
  contentType?: string;
  /** The URL of the check before the Claim. Without it the executor has no check. */
  precheckUrl?: string;
  /** How long the check may take. Default: PRECHECK_TIMEOUT_MS. */
  precheckTimeoutMs?: number;
}

const refuse = (status: number, code: string, message: string): PrecheckResult => ({ ok: false, status, code, message });

/** The words of a refusal for the buyer: one line, no control character, a limited length. */
function flatText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/ {2,}/g, " ").trim().slice(0, PRECHECK_MESSAGE_LIMIT);
}

/** At most `limit` bytes of a body as text. A body that fails is read as far as it came. */
async function readBounded(res: Response, limit: number): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // The text so far is what the service said.
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, limit).toString("utf8");
}

/** The refusal of the service as the buyer gets it: its status, its code and its words, or a default for each. */
function refusalOf(status: number, text: string): PrecheckResult {
  let code = "precheck_refused";
  let words = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      if ("error" in parsed && typeof parsed.error === "string" && CODE_RE.test(parsed.error)) code = parsed.error;
      if ("message" in parsed && typeof parsed.message === "string") words = flatText(parsed.message);
    }
  } catch {
    // Not JSON: the defaults stand.
  }
  return refuse(status, code, words !== "" ? words : `The service refused the job before the Claim (HTTP ${status}).`);
}

/**
 * Default Executor: POST the payload to the operator's service, return the body.
 * The call carries the job context as six x-vector headers (./context.ts). The
 * runtime builds the header set here. It passes no header of the buyer on.
 *
 * With `precheckUrl` the executor also has a check before the Claim: the same
 * POST (the payload as the body, the same headers) to that URL. A 2xx answer
 * is a go. Any other answer is a refusal. See `precheck` below.
 */
export function makeHttpCalloutExecutor(opts: HttpCalloutOpts): Executor {
  const executor: Executor = {
    async execute(job: ExecutorJob): Promise<ExecutorResult> {
      const budget = Math.max(1, Math.min(opts.timeoutMs, job.deadlineMs));
      const headers: Record<string, string> = {
        "content-type": opts.contentType ?? "application/json",
        ...contextHeaders(job.context),
      };
      if (opts.authHeader) headers.authorization = opts.authHeader;
      let res: Response;
      const started = Date.now();
      try {
        res = await fetch(opts.serviceUrl, {
          method: "POST",
          headers,
          body: job.requestPayload,
          signal: AbortSignal.timeout(budget),
        });
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        throw new ExecutorError(
          isTimeout ? "service_timeout" : "service_unreachable",
          `service call failed after ${Date.now() - started}ms: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const body = await res.text();
      if (!res.ok) {
        throw new ExecutorError(`service_http_${res.status}`, `service returned HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return { outputPayload: body, meta: { wallclock_ms: Date.now() - started } };
    },
  };
  const { precheckUrl } = opts;
  if (precheckUrl === undefined) return executor;

  const timeoutMs = opts.precheckTimeoutMs ?? PRECHECK_TIMEOUT_MS;
  /**
   * The check before the Claim.
   *   2xx            go.
   *   400 to 599     a refusal with that status, the code and the text of the
   *                  service (its JSON body has `error` and `message`).
   *   other status   a refusal 502. A redirect is not followed.
   *   no answer      a refusal 503: the service is not reachable, or it gave
   *                  no answer in `timeoutMs`.
   */
  executor.precheck = async (job: PrecheckJob): Promise<PrecheckResult> => {
    const headers: Record<string, string> = {
      "content-type": opts.contentType ?? "application/json",
      ...contextHeaders(job.context),
    };
    if (opts.authHeader) headers.authorization = opts.authHeader;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      let res: Response;
      try {
        res = await fetch(precheckUrl, {
          method: "POST",
          headers,
          body: job.requestPayload,
          signal: controller.signal,
          redirect: "manual",
        });
      } catch {
        return timedOut
          ? refuse(503, "precheck_timeout", "The service gave no answer to the check before the Claim in time.")
          : refuse(503, "precheck_unreachable", "The runtime could not reach the service for the check before the Claim.");
      }
      if (res.status >= 200 && res.status < 300) {
        void res.body?.cancel().catch(() => undefined);
        return { ok: true };
      }
      if (res.status < 400) {
        void res.body?.cancel().catch(() => undefined);
        return refuse(502, "precheck_bad_status",
          `The service answered the check before the Claim with HTTP ${res.status}. That is neither a go nor a refusal.`);
      }
      if (res.status === 401) {
        // The service refused the token of the runtime (SERVICE_AUTH_HEADER). That is a fault of the
        // operator, not of the buyer, and a buyer client reads 401 as "my credentials". The buyer gets 503.
        void res.body?.cancel().catch(() => undefined);
        console.warn("[precheck] the service answered 401: it refused the token of SERVICE_AUTH_HEADER, so the runtime cannot ask it");
        return refuse(503, "precheck_failed", "The runtime could not ask the service for the check before the Claim.");
      }
      return refusalOf(res.status, await readBounded(res, PRECHECK_BODY_LIMIT));
    } finally {
      clearTimeout(timer);
    }
  };
  return executor;
}
