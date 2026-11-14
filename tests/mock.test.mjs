// The mock's status codes, headers and response sequences are configurable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock } from "../mock-server.mjs";

async function withMock(fn) {
  const { server } = createMock();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + server.address().port;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}
const configure = (base, responses) =>
  fetch(base + "/__mock/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ responses }) });

test("default sequence is 503, 503, 200", () => withMock(async (base) => {
  const s = [];
  for (let i = 0; i < 4; i++) s.push((await fetch(base + "/flaky")).status);
  assert.deepEqual(s, [503, 503, 200, 200]);
}));

test("custom sequence, headers and body; last entry repeats", () => withMock(async (base) => {
  assert.equal((await configure(base, [{ status: 429, headers: { "Retry-After": "3" } }, { status: 201, body: { message: "made" } }])).status, 200);
  const a = await fetch(base + "/flaky");
  assert.equal(a.status, 429);
  assert.equal(a.headers.get("retry-after"), "3");
  const b = await fetch(base + "/flaky", { method: "PUT" });
  assert.equal(b.status, 201);
  assert.deepEqual(await b.json(), { message: "made", attempts: 2 });
  assert.equal((await fetch(base + "/flaky")).status, 201);
}));

test("httpDateFromNow sends a future HTTP-date", () => withMock(async (base) => {
  await configure(base, [{ status: 429, headers: { "Retry-After": { httpDateFromNow: 30 } } }]);
  const r = await fetch(base + "/flaky");
  const at = Date.parse(r.headers.get("retry-after"));
  assert.ok(at - Date.now() > 25000 && at - Date.now() <= 30000);
}));

test("request log records method and Idempotency-Key", () => withMock(async (base) => {
  await fetch(base + "/flaky", { method: "POST", headers: { "Idempotency-Key": "k1" } });
  const log = await (await fetch(base + "/__mock/requests")).json();
  assert.equal(log.count, 1);
  assert.equal(log.requests[0].method, "POST");
  assert.equal(log.requests[0].idempotencyKey, "k1");
  await fetch(base + "/__mock/reset", { method: "POST" });
  assert.equal((await (await fetch(base + "/__mock/requests")).json()).count, 0);
}));

test("bad config is rejected", () => withMock(async (base) => {
  assert.equal((await configure(base, [])).status, 400);
  assert.equal((await configure(base, [{ status: 999 }])).status, 400);
}));
