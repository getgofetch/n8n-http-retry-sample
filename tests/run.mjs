/** Import the sample workflow (plus a few Config variants) into a throwaway n8n + SQLite and execute it. */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const MOCK_PORT = 34771;
export const MOCK = "http://127.0.0.1:" + MOCK_PORT;

export async function startMock() {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-server.mjs");
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  });
  let ready = "";
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("mock server did not start")), 10000);
    child.stdout.on("data", (buf) => {
      ready += buf.toString();
      if (ready.includes("mock-ready")) { clearTimeout(t); resolve(); }
    });
    child.on("error", (err) => { clearTimeout(t); reject(err); });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) { clearTimeout(t); reject(new Error("mock server exited " + code + " " + ready)); }
    });
  });
  return {
    async configure(responses) {
      const r = await fetch(MOCK + "/__mock/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ responses }) });
      if (r.status !== 200) throw new Error("mock config failed: " + (await r.text()));
    },
    async requests() {
      return (await fetch(MOCK + "/__mock/requests")).json();
    },
    close() {
      child.kill("SIGTERM");
      return new Promise((r) => setTimeout(r, 50));
    },
  };
}

function n8nBin() {
  return process.env.N8N_BIN || "n8n";
}

function runN8n(args, env, timeoutMs = 180000) {
  const res = spawnSync(n8nBin(), args, { env, encoding: "utf8", timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const text = String(res.stdout || "") + String(res.stderr || "");
  if (res.status !== 0) throw new Error("n8n " + args.join(" ") + " exited " + res.status + "\n" + text.slice(-4000));
  return text;
}

function extractJson(text) {
  const i = text.indexOf("\n{") >= 0 ? text.indexOf("\n{") + 1 : text.indexOf("{");
  if (i < 0) throw new Error("no JSON in n8n output: " + text.slice(-400));
  return JSON.parse(text.slice(i));
}

/**
 * variants: { name: { find: replace, ... } } applied to the Config node's code.
 * Returns { execute(name) -> { node, item } } where node is the last node run (Result or Failed).
 */
export function setupN8n(workflowFile, variants = {}) {
  const bin = n8nBin();
  const userFolder = mkdtempSync(join(tmpdir(), "n8n-sample-"));
  const env = {
    ...process.env,
    N8N_USER_FOLDER: userFolder,
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_PERSONALIZATION_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_HIRING_BANNER_ENABLED: "false",
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "false",
  };
  delete env.N8N_LOG_LEVEL;
  delete env.N8N_ENCRYPTION_KEY;
  const help = spawnSync(bin, ["--help"], { env, encoding: "utf8", timeout: 30000 });
  if ((help.status !== 0 && help.status !== null) || !String(help.stdout || help.stderr || "").includes("execute")) {
    rmSync(userFolder, { recursive: true, force: true });
    throw new Error(
      "n8n is not available (set N8N_BIN or install n8n). Workflows were not executed. " +
      String(help.stderr || help.stdout || help.error || "failed to run n8n --help")
    );
  }
  const base = JSON.parse(readFileSync(workflowFile, "utf8"));
  const dir = join(userFolder, "import");
  mkdirSync(dir);
  writeFileSync(join(dir, base.name + ".json"), JSON.stringify(base));
  for (const [name, edits] of Object.entries(variants)) {
    const wf = JSON.parse(JSON.stringify(base));
    wf.name = name;
    const cfg = wf.nodes.find((n) => n.name === "Config");
    for (const [from, to] of Object.entries(edits)) {
      if (!cfg.parameters.jsCode.includes(from)) throw new Error("variant " + name + ": Config has no " + from);
      cfg.parameters.jsCode = cfg.parameters.jsCode.replace(from, to);
    }
    writeFileSync(join(dir, name + ".json"), JSON.stringify(wf));
  }
  const imported = runN8n(["import:workflow", "--separate", "--input", dir], env);
  if (!/Successfully imported/i.test(imported)) throw new Error("n8n import did not confirm success:\n" + imported.slice(-2000));
  const byName = {};
  for (const line of runN8n(["list:workflow"], env).split(/\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\|(.+)$/);
    if (m) byName[m[2].trim()] = m[1];
  }
  return {
    version: runN8n(["--version"], env).trim().split(/\s+/).pop(),
    execute(name) {
      const id = byName[name];
      if (!id) throw new Error("workflow not imported: " + name + " (have " + JSON.stringify(byName) + ")");
      const data = extractJson(runN8n(["execute", "--id=" + id, "--rawOutput"], env));
      if (data.status !== "success" || data.finished !== true) {
        throw new Error(name + " did not succeed: " + JSON.stringify({ status: data.status, error: data.data && data.data.resultData && data.data.resultData.error }));
      }
      const node = data.data.resultData.lastNodeExecuted;
      return { node, item: data.data.resultData.runData[node][0].data.main[0][0].json };
    },
    close() {
      try { rmSync(userFolder, { recursive: true, force: true }); } catch {}
    },
  };
}
