// Local mock API for the sample workflow. Listens on 127.0.0.1:34771 (MOCK_PORT to change).
//
// Any method on /flaky returns the next response from a configurable sequence.
// Default sequence: 503, 503, then 200 { message: "recovered" }. The last entry
// repeats once the sequence runs out. Every response body also gets `attempts`.
//
// Control endpoints (not used by the workflow):
//   POST /__mock/config    { "responses": [ { "status": 429, "headers": { "Retry-After": "1" }, "body": {...}, "delayMs": 0 } ] }
//                          Replaces the sequence and clears the counter and request log.
//                          A header value of { "httpDateFromNow": 2 } is sent as an HTTP-date 2 s in the future.
//   GET  /__mock/requests  { count, requests: [ { method, path, idempotencyKey, at } ] }
//   POST /__mock/reset     Clears the counter and request log, keeps the sequence.
//   POST /reset            Same as /__mock/reset (kept from v1).
//
// You can also start it with a sequence: MOCK_SEQUENCE='[{"status":401}]' node mock-server.mjs
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const DEFAULT_SEQUENCE = [
  { status: 503, body: { error: "temporary" } },
  { status: 503, body: { error: "temporary" } },
  { status: 200, body: { message: "recovered" } },
];

function normalise(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error("responses must be a non-empty array");
  return list.map((r, i) => {
    const status = Number(r && r.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("responses[" + i + "].status must be 100-599");
    return { status, headers: r.headers || {}, body: r.body, delayMs: Number(r.delayMs || 0) };
  });
}

function headerValue(v) {
  if (v && typeof v === "object" && "httpDateFromNow" in v) {
    return new Date(Date.now() + Number(v.httpDateFromNow) * 1000).toUTCString();
  }
  return String(v);
}

export function createMock(initial) {
  const state = { sequence: normalise(initial || DEFAULT_SEQUENCE), n: 0, requests: [] };

  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const send = (status, obj, extraHeaders = {}) => {
      const body = obj === undefined ? "" : JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), connection: "close", ...extraHeaders });
      res.end(req.method === "HEAD" ? undefined : body);
    };
    const readJson = (cb) => {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        try { cb(JSON.parse(raw || "{}")); } catch (err) { send(400, { error: "bad json: " + err.message }); }
      });
    };

    if (u.pathname === "/__mock/config" && req.method === "POST") {
      return readJson((cfg) => {
        try {
          state.sequence = normalise(cfg.responses);
          state.n = 0;
          state.requests = [];
          send(200, { ok: true, responses: state.sequence.length });
        } catch (err) {
          send(400, { error: err.message });
        }
      });
    }
    if (u.pathname === "/__mock/requests" && req.method === "GET") {
      return send(200, { count: state.requests.length, requests: state.requests });
    }
    if ((u.pathname === "/__mock/reset" || u.pathname === "/reset") && req.method === "POST") {
      state.n = 0;
      state.requests = [];
      return send(200, { ok: true, attempts: 0 });
    }
    if (u.pathname === "/flaky") {
      state.n += 1;
      state.requests.push({
        method: req.method,
        path: u.pathname,
        idempotencyKey: req.headers["idempotency-key"] || null,
        at: new Date().toISOString(),
      });
      const r = state.sequence[Math.min(state.n, state.sequence.length) - 1];
      const headers = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k, headerValue(v)]));
      const body = { ...(r.body && typeof r.body === "object" ? r.body : {}), attempts: state.n };
      const reply = () => {
        // Drain any request body first so the client never sees a reset.
        req.resume();
        send(r.status, body, headers);
      };
      return r.delayMs > 0 ? setTimeout(reply, r.delayMs) : reply();
    }
    send(404, { error: "not found", path: u.pathname });
  });
  return { server, state };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_PORT || 34771);
  const seq = process.env.MOCK_SEQUENCE ? JSON.parse(process.env.MOCK_SEQUENCE) : undefined;
  const { server } = createMock(seq);
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("mock-ready " + port + "\n");
  });
}
