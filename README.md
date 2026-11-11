# n8n HTTP retry sample

A single, importable n8n workflow that retries a failing HTTP request until the API recovers. MIT licensed. No account, no signup, and no paid nodes.

It was imported and executed on a local n8n (SQLite) against the mock server in this repo. The HTTP node is set to `retryOnFail`, with `maxTries: 3` and `waitBetweenTries: 200`.

This is a sample, not a hosted n8n. You run it on your own instance.

## Quick start

You need n8n 2.47 or newer, and Node 20+ for the mock and the tests.

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

Or, if you have n8n installed and `N8N_BIN` pointed at it:

```bash
npm test
```

The mock at `http://127.0.0.1:34771/flaky` returns HTTP 500 twice, then HTTP 200 with `{ "message": "recovered", "attempts": 3 }`. The workflow should finish with `ok: true`, `attempts: 3`, `message: "recovered"`.

To point it at your own API, change `apiBase` in the Config node, and restart the mock counter (`POST /reset`) if you re-run against the included server.

## What is in the workflow

| Node | What it does |
|---|---|
| Manual Trigger | Starts a run from the editor or `n8n execute` |
| Config | Sets `apiBase`, default `http://127.0.0.1:34771` |
| Fetch flaky | `GET {apiBase}/flaky`, retries on failure |
| Result | Returns `{ ok, attempts, message }` |

The workflow ships inactive. Leave it that way until `apiBase` points where you intend.

## Want more? Pro pack

This repo is one workflow, given away so you can see the retry pattern and run it yourself.

The paid n8n skill and workflows pack adds five more importable workflows (JSON transform, HTTP fetch and normalise, list filter, event digest, inbound payload validation), plus Claude / Cursor skills and a test suite that executes every flow on a local n8n. There is also an n8n agent pack for tool routing, an approval gate and output guardrails.

They are listed together here:

https://getgofetch.dev/kits

Until that page is live and the store is approved, there is nothing to buy. Checkout links on that page stay as placeholders until then. No support is promised on the packs either; the files are provided as is.

## Licence

MIT. See `LICENSE`.

No support is promised. Official n8n docs remain the source of truth when the product changes.
