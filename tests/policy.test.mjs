// Fast tests of the retry policy (the Decide and Config Code nodes), no n8n needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, nodeCode } from "./code-node.mjs";

const http = (statusCode, headers = {}, body = {}) => ({ statusCode, headers, body });
const NO_JITTER = { jitter: 0 };

test("2xx is success", () => {
  const d = decide(http(200, {}, { message: "hi" }));
  assert.equal(d.decision, "success");
  assert.equal(d.status, 200);
});

for (const status of [400, 401, 403, 404, 422]) {
  test(status + " fails immediately on the first attempt", () => {
    const d = decide(http(status));
    assert.equal(d.decision, "fail");
    assert.equal(d.reason, "not_retryable_status");
    assert.equal(d.status, status);
    assert.equal(d.attempts, 1);
  });
}

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(status + " is retried", () => {
    assert.equal(decide(http(status)).decision, "retry");
  });
}

test("501 and 505 are not retried", () => {
  assert.equal(decide(http(501)).decision, "fail");
  assert.equal(decide(http(505)).decision, "fail");
});

test("exponential backoff without jitter is 1 s, 4 s, 16 s", () => {
  const cfg = { ...NO_JITTER, maxAttempts: 4 };
  assert.equal(decide(http(503), { attempt: 1, config: cfg }).waitSeconds, 1);
  assert.equal(decide(http(503), { attempt: 2, config: cfg }).waitSeconds, 4);
  assert.equal(decide(http(503), { attempt: 3, config: cfg }).waitSeconds, 16);
});

test("jitter stays within +/-20% of the backoff", () => {
  for (let i = 0; i < 200; i++) {
    const w = decide(http(503), { attempt: 2 }).waitSeconds;
    assert.ok(w >= 3.2 && w <= 4.8, "wait " + w);
  }
});

test("backoff is capped at maxWaitMs", () => {
  const d = decide(http(503), { attempt: 3, config: { ...NO_JITTER, maxAttempts: 5, maxWaitMs: 5000 } });
  assert.equal(d.waitSeconds, 5);
});

test("attempts are capped at maxAttempts", () => {
  const d = decide(http(503), { attempt: 3 });
  assert.equal(d.decision, "fail");
  assert.equal(d.reason, "max_attempts_reached");
  assert.equal(d.attempts, 3);
});

test("429 honours Retry-After in seconds", () => {
  const d = decide(http(429, { "retry-after": "7" }));
  assert.equal(d.decision, "retry");
  assert.equal(d.reason, "retry_after");
  assert.equal(d.waitSeconds, 7);
});

test("429 honours Retry-After as an HTTP-date", () => {
  const at = new Date(Date.now() + 10000).toUTCString();
  const d = decide(http(429, { "Retry-After": at }));
  assert.equal(d.reason, "retry_after");
  assert.ok(d.waitSeconds > 8 && d.waitSeconds <= 10, "wait " + d.waitSeconds);
});

test("a past HTTP-date means retry now", () => {
  const d = decide(http(429, { "retry-after": new Date(Date.now() - 60000).toUTCString() }));
  assert.equal(d.decision, "retry");
  assert.equal(d.waitSeconds, 0);
});

test("503 also honours Retry-After", () => {
  assert.equal(decide(http(503, { "retry-after": "2" })).waitSeconds, 2);
});

test("an unreadable Retry-After falls back to backoff", () => {
  const d = decide(http(429, { "retry-after": "soon" }), { config: NO_JITTER });
  assert.equal(d.reason, "backoff");
  assert.equal(d.waitSeconds, 1);
});

test("a Retry-After longer than maxWaitMs fails fast instead of hammering", () => {
  const d = decide(http(429, { "retry-after": "120" }));
  assert.equal(d.decision, "fail");
  assert.equal(d.reason, "retry_after_exceeds_max_wait");
});

test("PUT, DELETE and HEAD are retried by default", () => {
  for (const method of ["PUT", "DELETE", "HEAD"]) {
    assert.equal(decide(http(503), { config: { method } }).decision, "retry", method);
  }
});

test("POST is not retried by default", () => {
  const d = decide(http(503), { config: { method: "POST" } });
  assert.equal(d.decision, "fail");
  assert.equal(d.reason, "method_not_retried");
});

test("POST is retried only with retryPost and an idempotency key", () => {
  assert.equal(decide(http(503), { config: { method: "POST", retryPost: true, idempotencyKey: "order-42" } }).decision, "retry");
  assert.equal(decide(http(503), { config: { method: "POST", retryPost: true, idempotencyKey: "" } }).decision, "fail");
});

test("Config refuses retryPost without an idempotency key", () => {
  const code = nodeCode("Config").replace("retryPost: false", "retryPost: true");
  assert.throws(() => new Function(code)(), /idempotencyKey/);
});

test("network errors from the error output are retried", () => {
  const d = decide({ error: { message: "connect ECONNREFUSED 127.0.0.1:1" } });
  assert.equal(d.decision, "retry");
  assert.equal(d.status, null);
  assert.match(d.error, /ECONNREFUSED/);
});

test("timeouts are retried", () => {
  assert.equal(decide({ error: { message: "timeout of 10000ms exceeded", code: "ECONNABORTED" } }).decision, "retry");
});

test("other node errors are not retried", () => {
  const d = decide({ error: { message: "Invalid URL: not a url" } });
  assert.equal(d.decision, "fail");
  assert.equal(d.reason, "not_retryable_error");
});
