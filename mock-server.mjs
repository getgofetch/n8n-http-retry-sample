// Local mock for the sample workflow. Listens on 127.0.0.1:34771
// GET /flaky returns 500 twice, then 200 with { message: "recovered", attempts }.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_PORT || 34771);
const flaky = { n: 0 };
const server = createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  const send = (status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
  };
  if (req.method === "GET" && u.pathname === "/flaky") {
    flaky.n += 1;
    if (flaky.n < 3) return send(500, { error: "temporary", attempts: flaky.n });
    return send(200, { message: "recovered", attempts: flaky.n });
  }
  if (req.method === "POST" && u.pathname === "/reset") {
    flaky.n = 0;
    return send(200, { ok: true, attempts: 0 });
  }
  send(404, { error: "not found", path: u.pathname });
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write("mock-ready " + port + "\n");
});
