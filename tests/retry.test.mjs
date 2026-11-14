// Structure checks, then real executions on a local n8n against the configurable mock.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, WORKFLOW, loadWorkflow } from "./code-node.mjs";
import { startMock, setupN8n } from "./run.mjs";

test("required files exist", () => {
  for (const rel of ["README.md", "LICENSE", "CHANGELOG.md", "mock-server.mjs", "workflows/http-retry-on-error.json"]) {
    assert.ok(existsSync(join(ROOT, rel)), rel);
  }
});

test("workflow shape: inactive, Manual Trigger, no blanket retryOnFail, error output wired", () => {
  const wf = loadWorkflow();
  assert.equal(wf.active, false);
  assert.equal(wf.nodes[0].type, "n8n-nodes-base.manualTrigger");
  const http = wf.nodes.find((n) => n.type === "n8n-nodes-base.httpRequest");
  assert.ok(http, "http request node");
  assert.notEqual(http.retryOnFail, true, "retries are decided by status, not retryOnFail");
  assert.equal(http.onError, "continueErrorOutput");
  assert.equal(http.parameters.options.response.response.neverError, true);
  assert.equal(http.parameters.options.response.response.fullResponse, true);
  const outs = wf.connections["HTTP Request"].main;
  assert.equal(outs.length, 2, "success and error outputs");
  assert.equal(outs[1][0].node, "Decide", "error output goes to Decide");
  const route = wf.connections.Route.main.map((o) => o[0].node);
  assert.deepEqual(route, ["Wait (backoff or Retry-After)", "Result", "Failed"]);
  assert.equal(wf.connections["Wait (backoff or Retry-After)"].main[0][0].node, "HTTP Request");
});

const VARIANTS = {
  "retry-network": { "apiBase: 'http://127.0.0.1:34771'": "apiBase: 'http://127.0.0.1:1'" },
  "retry-post": { "method: 'GET'": "method: 'POST'" },
  "retry-post-optin": { "method: 'GET'": "method: 'POST'", "retryPost: false": "retryPost: true", "idempotencyKey: ''": "idempotencyKey: 'order-42'" },
};

let mock;
let n8n;
before(async () => {
  mock = await startMock();
  n8n = setupN8n(WORKFLOW, VARIANTS);
  console.log("# n8n version " + n8n.version);
});
after(async () => {
  if (n8n) n8n.close();
  if (mock) await mock.close();
});

async function run(responses, name = "http-retry-on-error") {
  if (responses) await mock.configure(responses);
  const t0 = Date.now();
  const out = n8n.execute(name);
  const log = await mock.requests();
  const at = log.requests.map((r) => Date.parse(r.at));
  return { ...out, count: log.count, requests: log.requests, gaps: at.slice(1).map((t, i) => t - at[i]), ms: Date.now() - t0 };
}

test("default mock: 503, 503, 200 recovers on attempt 3", async () => {
  const r = await run([{ status: 503 }, { status: 503 }, { status: 200, body: { message: "recovered" } }]);
  assert.equal(r.node, "Result");
  assert.deepEqual(r.item, { ok: true, status: 200, attempts: 3, message: "recovered" });
  assert.equal(r.count, 3);
  assert.ok(r.gaps[0] >= 700 && r.gaps[0] < 2500, "first wait ~1 s, got " + r.gaps[0]);
  assert.ok(r.gaps[1] >= 3000 && r.gaps[1] < 6000, "second wait ~4 s, got " + r.gaps[1]);
});

test("three 503s: exactly 3 requests, final status visible on the Failed branch", async () => {
  const r = await run([{ status: 503 }]);
  assert.equal(r.node, "Failed");
  assert.equal(r.count, 3);
  assert.equal(r.item.ok, false);
  assert.equal(r.item.status, 503);
  assert.equal(r.item.attempts, 3);
  assert.equal(r.item.reason, "max_attempts_reached");
});

test("401: exactly 1 request, no retry", async () => {
  const r = await run([{ status: 401, body: { error: "bad token" } }]);
  assert.equal(r.node, "Failed");
  assert.equal(r.count, 1);
  assert.equal(r.item.status, 401);
  assert.equal(r.item.attempts, 1);
  assert.equal(r.item.reason, "not_retryable_status");
});

test("429 with Retry-After: 2 waits ~2 s, then succeeds", async () => {
  const r = await run([{ status: 429, headers: { "Retry-After": "2" } }, { status: 200, body: { message: "recovered" } }]);
  assert.equal(r.node, "Result");
  assert.equal(r.count, 2);
  assert.equal(r.item.attempts, 2);
  assert.ok(r.gaps[0] >= 1900, "waited " + r.gaps[0] + " ms");
});

test("429 with Retry-After as an HTTP-date is honoured", async () => {
  const r = await run([{ status: 429, headers: { "Retry-After": { httpDateFromNow: 3 } } }, { status: 200, body: { message: "recovered" } }]);
  assert.equal(r.node, "Result");
  assert.equal(r.count, 2);
  // HTTP-dates have 1 s resolution, so 3 s from now is 2-3 s away.
  assert.ok(r.gaps[0] >= 1800, "waited " + r.gaps[0] + " ms");
});

test("429 with a Retry-After above maxWaitMs fails fast", async () => {
  const r = await run([{ status: 429, headers: { "Retry-After": "120" } }]);
  assert.equal(r.node, "Failed");
  assert.equal(r.count, 1);
  assert.equal(r.item.reason, "retry_after_exceeds_max_wait");
});

test("503 then 200 recovers on attempt 2", async () => {
  const r = await run([{ status: 503 }, { status: 200, body: { message: "recovered" } }]);
  assert.deepEqual(r.item, { ok: true, status: 200, attempts: 2, message: "recovered" });
  assert.equal(r.count, 2);
});

test("POST is not retried without the opt-in", async () => {
  const r = await run([{ status: 503 }, { status: 200 }], "retry-post");
  assert.equal(r.node, "Failed");
  assert.equal(r.count, 1);
  assert.equal(r.item.reason, "method_not_retried");
});

test("POST with retryPost + idempotency key is retried and sends the key every time", async () => {
  const r = await run([{ status: 503 }, { status: 200, body: { message: "created" } }], "retry-post-optin");
  assert.equal(r.node, "Result");
  assert.equal(r.count, 2);
  assert.deepEqual(r.requests.map((q) => [q.method, q.idempotencyKey]), [["POST", "order-42"], ["POST", "order-42"]]);
});

test("network error (connection refused) is retried, then ends on the Failed branch", async () => {
  await mock.configure([{ status: 200 }]);
  const r = n8n.execute("retry-network");
  assert.equal(r.node, "Failed");
  assert.equal(r.item.status, null);
  assert.equal(r.item.attempts, 3);
  assert.equal(r.item.reason, "max_attempts_reached");
  assert.match(String(r.item.error), /ECONNREFUSED|refused/i);
});
