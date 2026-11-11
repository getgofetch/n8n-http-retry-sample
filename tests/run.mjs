/** Import and execute the sample workflow with a local n8n + SQLite. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

export const MOCK_PORT = 34771;

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
      if (ready.includes("mock-ready")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on("error", (err) => { clearTimeout(t); reject(err); });
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(t);
        reject(new Error("mock server exited " + code + " " + ready));
      }
    });
  });
  return {
    close(cb) {
      child.kill("SIGTERM");
      if (cb) setTimeout(cb, 50);
    },
  };
}

function n8nBin() {
  return process.env.N8N_BIN || "n8n";
}

function runN8n(args, env, timeoutMs = 180000) {
  const res = spawnSync(n8nBin(), args, {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const text = String(res.stdout || "") + String(res.stderr || "");
  if (res.status !== 0) {
    throw new Error("n8n " + args.join(" ") + " exited " + res.status + "\n" + text.slice(-4000));
  }
  return text;
}

function extractJson(text) {
  const i = text.indexOf("\n{") >= 0 ? text.indexOf("\n{") + 1 : text.indexOf("{");
  if (i < 0) throw new Error("no JSON in n8n output: " + text.slice(-400));
  return JSON.parse(text.slice(i));
}

export function executeSample(workflowsDir) {
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
    throw new Error(
      "n8n is not available (set N8N_BIN or install n8n). Workflows were not executed. " +
      String(help.stderr || help.stdout || help.error || "failed to run n8n --help")
    );
  }
  try {
    const imported = runN8n(["import:workflow", "--separate", "--input", workflowsDir], env);
    if (!/Successfully imported/i.test(imported)) {
      throw new Error("n8n import did not confirm success:\n" + imported.slice(-2000));
    }
    const listOut = runN8n(["list:workflow"], env);
    const byName = {};
    for (const line of listOut.split(/\n/)) {
      const m = line.match(/^([A-Za-z0-9_-]+)\|(.+)$/);
      if (m) byName[m[2].trim()] = m[1];
    }
    const name = "http-retry-on-error";
    const id = byName[name];
    if (!id) throw new Error("workflow not imported: " + name + " (have " + JSON.stringify(byName) + ")");
    const raw = runN8n(["execute", "--id=" + id, "--rawOutput"], env);
    const data = extractJson(raw);
    if (data.status !== "success" || data.finished !== true) {
      throw new Error(name + " did not succeed: " + JSON.stringify({ status: data.status, error: data.data && data.data.resultData && data.data.resultData.error }));
    }
    const last = data.data.resultData.lastNodeExecuted;
    const item = data.data.resultData.runData[last][0].data.main[0][0].json;
    return item;
  } finally {
    try { rmSync(userFolder, { recursive: true, force: true }); } catch {}
  }
}
