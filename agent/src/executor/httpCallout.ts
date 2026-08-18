import { type Executor, type ExecutorJob, type ExecutorResult, ExecutorError } from "./executor.js";

export interface HttpCalloutOpts {
  serviceUrl: string;
  timeoutMs: number;
  authHeader?: string;
  contentType?: string;
}

/** Default Executor: POST the payload to the operator's service, return the body. */
export function makeHttpCalloutExecutor(opts: HttpCalloutOpts): Executor {
  return {
    async execute(job: ExecutorJob): Promise<ExecutorResult> {
      const budget = Math.max(1, Math.min(opts.timeoutMs, job.deadlineMs));
      const headers: Record<string, string> = {
        "content-type": opts.contentType ?? "application/json",
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
}
