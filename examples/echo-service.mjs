// Minimal black-box service for the quickstart demo and e2e tests.
// POST anything -> {"echo": <body>, "length": n}
import { createServer } from "node:http";
const port = Number(process.env.PORT ?? 9091);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ echo: body, length: body.length }));
  });
}).listen(port, "127.0.0.1", () => console.log(`[echo-service] listening on :${port}`));
