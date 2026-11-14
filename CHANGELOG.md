# Changelog

## 2.0.0 (14 Nov 2026)

Rebuilt from feedback on the r/n8n post and the n8n community forum topic. Thank you to
**Titouan_Mouzer**, **FanneMishari-35**, **Saved_Not_Soft**, **Low_Rush_8535** and **NoDevelopment206** on r/n8n,
and **alexcarter159** on the n8n forum. Every point below came from you.

- **Status-aware retries.** Only network errors, timeouts, 408, 429 and 5xx (not 501/505) are retried.
  400, 401, 403, 404, 422 and other 4xx fail on the first attempt. v1 used `retryOnFail`, which retried everything,
  including a 401 that can lock credentials.
- **Exponential backoff with jitter** (~1 s, ~4 s, ~16 s, +/- 20%) and a cap on attempts (`maxAttempts`), replacing the
  fixed 200 ms wait.
- **Retry-After honoured** on 429 and 503, in both delta-seconds and HTTP-date form, with a maximum wait (`maxWaitMs`).
  A longer Retry-After fails fast.
- **Idempotent methods only by default.** GET, HEAD, OPTIONS, PUT and DELETE retry. POST/PATCH retry only with `retryPost: true`
  plus an `idempotencyKey`, sent as the `Idempotency-Key` header on every attempt.
- **Failure branch.** The HTTP node uses On Error > Continue (using error output) for network errors, and every final
  failure goes to a `Failed` node showing `status`, `attempts` and `reason`, then a Stop and Error node marks the
  execution as failed. Deleting Stop and Error is documented as an option if you want the run to end quietly.
- **Configurable mock.** Status codes, headers (including a future HTTP-date) and response sequences can be set per run,
  and every request is logged with its method and Idempotency-Key.
- **More tests.** Three 503s give exactly 3 requests and a visible final status; a 401 gives exactly 1 request;
  429 with Retry-After (seconds and HTTP-date); 503 then 200; POST with and without the opt-in; connection refused.
  Executed on n8n 2.47.4.

## 1.0.0 (11 Nov 2026)

- First release: Manual Trigger, Config, HTTP Request with `retryOnFail` (3 tries, 200 ms), Result. Mock returns 500 twice, then 200.
