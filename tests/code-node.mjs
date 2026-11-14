/** Run a Code node's JavaScript from the workflow JSON in plain Node, with fake n8n globals. */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOW = join(ROOT, "workflows/http-retry-on-error.json");

export function loadWorkflow() {
  return JSON.parse(readFileSync(WORKFLOW, "utf8"));
}

export function nodeCode(name) {
  const node = loadWorkflow().nodes.find((n) => n.name === name);
  if (!node) throw new Error("no node " + name);
  return node.parameters.jsCode;
}

export function defaultConfig(overrides = {}) {
  const out = new Function(nodeCode("Config"))();
  return { ...out[0].json, ...overrides };
}

/** Run the Decide node for one HTTP result. */
export function decide(response, { attempt = 1, config = {} } = {}) {
  const cfg = defaultConfig(config);
  const $ = (name) => {
    if (name !== "Config") throw new Error("unexpected node " + name);
    return { first: () => ({ json: cfg }) };
  };
  const $input = { first: () => ({ json: response }) };
  const out = new Function("$", "$input", "$runIndex", nodeCode("Decide"))($, $input, attempt - 1);
  return out[0].json;
}
