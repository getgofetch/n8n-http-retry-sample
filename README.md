# n8n HTTP retry sample

A single, importable n8n workflow that retries a failing HTTP request the way most APIs expect: only when a retry can help, with growing waits, and with a clear failure branch when it gives up. MIT licensed. No account, no signup, and no paid nodes.

v2 was rebuilt from community feedback on r/n8n and the n8n forum (see `CHANGELOG.md`). It was imported and executed on a local n8n 2.47.4 (SQLite) against the mock server in this repo.

This is a sample, not a hosted n8n. You run it on your own instance.

## What it does

| Situation | What happens |
|---|---|
| 2xx / 3xx | Success. `Result` returns `{ ok: true, status, attempts, message }` |
| Network error, timeout, 408, 429, 5xx (not 501/505) | Retried with exponential backoff and jitter: ~1 s, ~4 s, ~16 s ... up to `maxAttempts` |
| 429 or 503 with `Retry-After` | Waits what the server asked, in seconds (`Retry-After: 2`) or an HTTP-date. If that is longer than `maxWaitMs`, it fails fast instead of hammering |
| 400, 401, 403, 404, 422 and other 4xx | Fails on the first attempt. Retrying a 401 can lock an account |
| POST / PATCH | Not retried, unless you set `retryPost: true` **and** an `idempotencyKey` (sent as the `Idempotency-Key` header) |
| Retries used up | `Failed` returns `{ ok: false, status, attempts, reason, error }` |

## Quick start

You need n8n 2.47 or newer (this sample was executed on 2.47.4), and Node 20+ for the mock and the tests.

```bash
git clone https://github.com/getgofetch/n8n-http-retry-sample
cd n8n-http-retry-sample
node mock-server.mjs
```

In another terminal:

```bash
n8n import:workflow --separate --input=workflows/
n8n list:workflow
n8n execute --id=<id>
```

By default the mock at `http://127.0.0.1:34771/flaky` returns 503, 503, then 200 with `{ "message": "recovered" }`. The run should end on `Result` with `ok: true`, `status: 200`, `attempts: 3` after about 5 seconds of backoff. Restart the mock (or `POST /__mock/reset`) before re-running.

## Settings (Config node)

| Setting | Default | Notes |
|---|---|---|
| `apiBase`, `path` | `http://127.0.0.1:34771`, `/flaky` | Point these at your API |
| `method` | `GET` | GET, HEAD, PUT, DELETE are retried by default |
| `retryPost` | `false` | POST/PATCH retry opt-in. Needs `idempotencyKey`, or Config stops the run |
| `idempotencyKey` | `''` | Sent as `Idempotency-Key` on every attempt |
| `maxAttempts` | `3` | Total requests including the first. Set 4 for a third retry at ~16 s |
| `baseDelayMs`, `backoffFactor`, `jitter` | `1000`, `4`, `0.2` | Wait before retry n is `baseDelayMs * backoffFactor^(n-1)`, +/- 20% |
| `maxWaitMs` | `30000` | Longest single wait. Keep it under 65 s so the wait stays in memory |
| `timeoutMs` | `10000` | Per-request timeout |

For a POST or PUT with a body, turn on **Send Body** in the HTTP Request node.

## What is in the workflow

| Node | What it does |
|---|---|
| Manual Trigger | Starts a run from the editor or `n8n execute` |
| Config | The settings above |
| HTTP Request | One attempt. **Never Error** + **Full Response** so the status and `Retry-After` come back as data. **On Error > Continue (using error output)** sends network errors and timeouts on the error output. No `retryOnFail` |
| Decide | Classifies the result: `success`, `retry` (with `waitSeconds`) or `fail` (with `reason`) |
| Route | Switch on the decision |
| Wait (backoff or Retry-After) | Waits `waitSeconds`, then loops back to HTTP Request |
| Result | Success output |
| Failed | Final failure, with status and attempt count. In production, add a Stop and Error node or an alert after it |

The workflow ships inactive. Leave it that way until `apiBase` points where you intend.

## The mock

`mock-server.mjs` serves any method on `/flaky` from a configurable sequence of responses. The last one repeats.

```bash
# 429 with Retry-After: 2, then success
curl -X POST http://127.0.0.1:34771/__mock/config -H 'content-type: application/json' \
  -d '{"responses":[{"status":429,"headers":{"Retry-After":"2"}},{"status":200,"body":{"message":"ok"}}]}'

# Retry-After as an HTTP-date 3 s in the future
curl -X POST http://127.0.0.1:34771/__mock/config -H 'content-type: application/json' \
  -d '{"responses":[{"status":429,"headers":{"Retry-After":{"httpDateFromNow":3}}},{"status":200}]}'

curl http://127.0.0.1:34771/__mock/requests   # count, methods, Idempotency-Key per request
```

Each entry takes `status`, `headers`, `body` and `delayMs`. You can also start it with `MOCK_SEQUENCE='[{"status":401}]' node mock-server.mjs`.

## Tests

```bash
npm run test:unit                 # retry policy + mock, no n8n needed
N8N_BIN=$(which n8n) npm test     # also imports and executes the workflow on a throwaway n8n
```

The n8n tests check, against real executions:
- 503, 503, 200: recovers on attempt 3, with ~1 s and ~4 s waits
- three 503s: exactly 3 requests, ends on `Failed` with `status: 503`, `attempts: 3`
- 401: exactly 1 request
- 429 with `Retry-After` in seconds and as an HTTP-date: waits at least that long
- 429 with a `Retry-After` above `maxWaitMs`: fails fast, 1 request
- 503 then 200: recovers on attempt 2
- POST: 1 request by default; retried with the same `Idempotency-Key` when opted in
- connection refused: retried, then `Failed` with the error message

## Licence

MIT. See `LICENSE`.

No support is promised. Official n8n docs remain the source of truth when the product changes.
