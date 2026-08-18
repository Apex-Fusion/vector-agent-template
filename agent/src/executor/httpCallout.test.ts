import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { makeHttpCalloutExecutor } from "./httpCallout.js";
import { ExecutorError } from "./executor.js";

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

describe("httpCallout executor", () => {
  const job = { capabilityId: "x.y.z.v1", requestPayload: '{"a":1}', deadlineMs: 60_000, jobRef: "ref#0" };

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
