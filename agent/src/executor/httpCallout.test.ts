import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { makeHttpCalloutExecutor } from "./httpCallout.js";
import { ExecutorError, type JobContext } from "./executor.js";

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ echoed: body, auth: req.headers.authorization ?? null }));
      } else if (req.url === "/echo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body }));
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
