// Minimal black-box service for the quickstart demo and e2e tests.
// POST anything -> {"echo": <body>, "length": n}
// HOST defaults to loopback so a local run is not exposed to your network.
// deploy/docker-compose.yml sets HOST=0.0.0.0: inside a container, loopback is
// that container alone and the agent could never reach it.
import { createServer } from "node:http";
const port = Number(process.env.PORT ?? 9091);
const host = process.env.HOST ?? "127.0.0.1";
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: body, length: body.length }));
  });
}).listen(port, host, () => console.log(`[echo-service] listening on ${host}:${port}`));
