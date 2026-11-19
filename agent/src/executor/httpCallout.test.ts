import { once } from "node:events";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { makeHttpCalloutExecutor, PRECHECK_TIMEOUT_MS } from "./httpCallout.js";
import { ExecutorError, type JobContext, type PrecheckJob } from "./executor.js";

/** Every request that the test server got, with its body. */
const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders; body: string }> = [];

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: body, auth: req.headers.authorization ?? null }));
      } else if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      } else if (req.url?.startsWith("/status/")) {
        res.writeHead(Number(req.url.slice("/status/".length)), { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "approval_digest_mismatch", message: "The digest does not match." }));
      } else if (req.url === "/plain") {
        res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
      } else if (req.url === "/odd") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not a code!", message: `line one\nline two\u0007 ${"x".repeat(1_000)}` }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: `${base}/echo` }).end();
      } else if (req.url === "/slow") {
        setTimeout(() => res.writeHead(200).end("late"), 5_000);
      } else {
        res.writeHead(503).end("down");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => server.close());

/** The job context of an escrow: what the runtime knows from the chain. */
const CONTEXT: JobContext = {
  escrowRef: `${"c".repeat(64)}#2`,
  advertRef: `${"a".repeat(64)}#0`,
  advertModel: "my-product-v1",
  buyerPkh: "4f".repeat(28),
  paymentLovelace: "2000000",
  deliverByMs: 1_900_000_000_000,
};

/** The six headers that carry the context to the service, with the value of CONTEXT. */
const CONTEXT_HEADERS: Record<string, string> = {
  "x-vector-escrow-ref": CONTEXT.escrowRef,
  "x-vector-advert-ref": CONTEXT.advertRef,
  "x-vector-advert-model": "my-product-v1",
  "x-vector-buyer-pkh": CONTEXT.buyerPkh,
  "x-vector-payment-lovelace": "2000000",
  "x-vector-deliver-by-ms": "1900000000000",
};

describe("httpCallout executor", () => {
  const job = { capabilityId: "x.y.z.v1", requestPayload: '{"a":1}', deadlineMs: 60_000, jobRef: "ref#0", context: CONTEXT };

  it("POSTs the payload and returns the body verbatim", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/ok`, timeoutMs: 2_000 });
    const r = await ex.execute(job);
    expect(JSON.parse(r.outputPayload)).toEqual({ echoed: '{"a":1}', auth: null });
  });

  it("sends the auth header when configured", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/ok`, timeoutMs: 2_000, authHeader: "Bearer t0" });
    const r = await ex.execute(job);
    expect(JSON.parse(r.outputPayload).auth).toBe("Bearer t0");
  });

  it("maps non-2xx to ExecutorError with service_http_<status>", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/down`, timeoutMs: 2_000 });
    await expect(ex.execute(job)).rejects.toMatchObject({ name: "ExecutorError", reason: "service_http_503" });
  });

  it("times out against min(timeoutMs, deadlineMs) with service_timeout", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/slow`, timeoutMs: 60_000 });
    await expect(ex.execute({ ...job, deadlineMs: 300 })).rejects.toMatchObject({ reason: "service_timeout" });
  });

  it("maps connection refusal to service_unreachable", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: "http://127.0.0.1:9/none", timeoutMs: 1_000 });
    await expect(ex.execute(job)).rejects.toMatchObject({ reason: "service_unreachable" });
  });
});

describe("httpCallout executor: the job context", () => {
  const job = { capabilityId: "x.y.z.v1", requestPayload: '{"a":1}', deadlineMs: 60_000, jobRef: "ref#0", context: CONTEXT };
  async function sent(overrides: Partial<JobContext> = {}) {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/echo`, timeoutMs: 2_000, authHeader: "Bearer t0" });
    const r = await ex.execute({ ...job, context: { ...CONTEXT, ...overrides } });
    return JSON.parse(r.outputPayload) as { method: string; headers: Record<string, string>; body: string };
  }

  it("sends the six context headers with the values of the escrow", async () => {
    const { headers } = await sent();
    for (const [name, value] of Object.entries(CONTEXT_HEADERS)) expect(headers[name]).toBe(value);
  });

  it("sends no other x-vector header", async () => {
    const { headers } = await sent();
    expect(Object.keys(headers).filter((name) => name.startsWith("x-vector-")).sort()).toEqual(Object.keys(CONTEXT_HEADERS).sort());
  });

  it("keeps the body, the content type and the authorization header as before", async () => {
    const { method, headers, body } = await sent();
    expect(method).toBe("POST");
    expect(body).toBe('{"a":1}');
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer t0");
  });

  it("percent-encodes the advert model, so that any text is a valid header value", async () => {
    const model = "lot medium / café\n";
    const { headers } = await sent({ advertModel: model });
    expect(headers["x-vector-advert-model"]).toBe(encodeURIComponent(model));
    expect(decodeURIComponent(headers["x-vector-advert-model"]!)).toBe(model);
  });
});

describe("httpCallout executor: the check before the Claim", () => {
  const job: PrecheckJob = { capabilityId: "x.y.z.v1", requestPayload: '{"a":1}', jobRef: "ref#0", context: CONTEXT };
  const precheckAt = (path: string) =>
    makeHttpCalloutExecutor({ serviceUrl: `${base}/ok`, timeoutMs: 2_000, precheckUrl: `${base}${path}`, authHeader: "Bearer t0" });

  afterEach(() => {
    seen.length = 0;
  });

  it("has no check when no URL is set", () => {
    expect(makeHttpCalloutExecutor({ serviceUrl: `${base}/ok`, timeoutMs: 2_000 }).precheck).toBeUndefined();
  });

  it("POSTs the payload with the context and the authorization header to the URL of the check", async () => {
    expect(await precheckAt("/echo").precheck!(job)).toEqual({ ok: true });

    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call!.method).toBe("POST");
    expect(call!.url).toBe("/echo");
    expect(call!.body).toBe('{"a":1}');
    expect(call!.headers["content-type"]).toBe("application/json");
    expect(call!.headers.authorization).toBe("Bearer t0");
    expect(call!.headers["x-vector-escrow-ref"]).toBe(CONTEXT.escrowRef);
    expect(call!.headers["x-vector-advert-ref"]).toBe(CONTEXT.advertRef);
    expect(call!.headers["x-vector-advert-model"]).toBe("my-product-v1");
    expect(call!.headers["x-vector-buyer-pkh"]).toBe(CONTEXT.buyerPkh);
    expect(call!.headers["x-vector-payment-lovelace"]).toBe("2000000");
    expect(call!.headers["x-vector-deliver-by-ms"]).toBe("1900000000000");
  });

  it.each([200, 204])("takes the status %i as go", async (status) => {
    expect(await precheckAt(`/status/${status}`).precheck!(job)).toEqual({ ok: true });
  });

  it.each([400, 403, 409, 422, 500, 503])("refuses with the status %i and the code and the text of the service", async (status) => {
    expect(await precheckAt(`/status/${status}`).precheck!(job)).toEqual({
      ok: false,
      status,
      code: "approval_digest_mismatch",
      message: "The digest does not match.",
    });
  });

  it("gives a refusal without a JSON body the status, a default code and a default text", async () => {
    expect(await precheckAt("/plain").precheck!(job)).toEqual({
      ok: false,
      status: 403,
      code: "precheck_refused",
      message: "The service refused the job before the Claim (HTTP 403).",
    });
  });

  it("replaces a code that is not a plain code, and flattens and cuts a long text", async () => {
    const verdict = await precheckAt("/odd").precheck!(job);
    if (verdict.ok) throw new Error("the check must refuse");
    expect(verdict).toMatchObject({ status: 403, code: "precheck_refused" });
    expect(verdict.message.startsWith("line one line two ")).toBe(true);
    expect(verdict.message).toHaveLength(500);
    expect(verdict.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it("does not follow a redirect: the answer is a refusal 502, and the target gets no call", async () => {
    const verdict = await precheckAt("/redirect").precheck!(job);
    expect(verdict).toMatchObject({ ok: false, status: 502, code: "precheck_bad_status" });
    expect(seen.map((call) => call.url)).toEqual(["/redirect"]);
  });

  it("refuses with 503 when the service cannot be reached", async () => {
    const ex = makeHttpCalloutExecutor({ serviceUrl: `${base}/ok`, timeoutMs: 2_000, precheckUrl: "http://127.0.0.1:9/precheck" });
    expect(await ex.precheck!(job)).toMatchObject({ ok: false, status: 503, code: "precheck_unreachable" });
  });

  it("maps a 401 of the service to a refusal 503 of the runtime, and names the cause in the log without the token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const verdict = await precheckAt("/status/401").precheck!(job);

      expect(verdict).toEqual({
        ok: false,
        status: 503,
        code: "precheck_failed",
        message: "The runtime could not ask the service for the check before the Claim.",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0]![0]);
      expect(line).toContain("401");
      expect(line).toContain("SERVICE_AUTH_HEADER");
      expect(line).not.toContain("Bearer t0");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a 403 of the service as it is, the twin of the 401", async () => {
    expect(await precheckAt("/status/403").precheck!(job)).toEqual({
      ok: false,
      status: 403,
      code: "approval_digest_mismatch",
      message: "The digest does not match.",
    });
  });
});

describe("httpCallout executor: no answer to the check before the Claim", () => {
  const job: PrecheckJob = { capabilityId: "x.y.z.v1", requestPayload: '{"a":1}', jobRef: "ref#0", context: CONTEXT };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("waits 10 seconds for the answer", () => {
    expect(PRECHECK_TIMEOUT_MS).toBe(10_000);
  });

  it("refuses with 503 when there is no answer in 10 seconds, and not before", async () => {
    vi.useFakeTimers();
    // A service that never answers: the call ends only when the runtime aborts it.
    const hang = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await once(init!.signal!, "abort");
      throw new DOMException("aborted", "AbortError");
    });
    vi.stubGlobal("fetch", hang);
    const ex = makeHttpCalloutExecutor({ serviceUrl: "http://service.test/job", timeoutMs: 120_000, precheckUrl: "http://service.test/precheck" });

    let verdict: unknown;
    const pending = ex.precheck!(job).then((v) => { verdict = v; });
    await vi.advanceTimersByTimeAsync(PRECHECK_TIMEOUT_MS - 1);
    expect(verdict).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(verdict).toMatchObject({ ok: false, status: 503, code: "precheck_timeout" });
    expect(hang).toHaveBeenCalledTimes(1);
  });
});
