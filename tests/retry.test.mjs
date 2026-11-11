import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startMock, executeSample } from "./run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

test("required files exist", () => {
  for (const rel of ["README.md", "LICENSE", "mock-server.mjs", "workflows/http-retry-on-error.json"]) {
    assert.ok(existsSync(join(ROOT, rel)), rel);
  }
});

test("workflow is inactive, starts with a Manual Trigger, and retries on fail", () => {
  const wf = JSON.parse(readFileSync(join(ROOT, "workflows/http-retry-on-error.json"), "utf8"));
  assert.equal(wf.active, false);
  assert.equal(wf.nodes[0].type, "n8n-nodes-base.manualTrigger");
  const http = wf.nodes.find((n) => n.type === "n8n-nodes-base.httpRequest");
  assert.ok(http, "http request node");
  assert.equal(http.retryOnFail, true);
  assert.equal(http.maxTries, 3);
  assert.equal(http.waitBetweenTries, 200);
});

test("import and execute against the local mock", async () => {
  const server = await startMock();
  try {
    const item = executeSample(join(ROOT, "workflows"));
    assert.equal(item.ok, true);
    assert.equal(item.attempts, 3);
    assert.equal(item.message, "recovered");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
