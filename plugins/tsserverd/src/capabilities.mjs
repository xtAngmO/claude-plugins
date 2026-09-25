// capabilities.mjs — the answer to a session's `initialize`.
//
// A session asks for capabilities before it names a single file, so the router
// cannot know which project to ask. typescript-language-server's capabilities
// depend on its own version and on what the client says it supports, not on
// the project, so they are learned once — from a short-lived private server —
// and cached on disk. Every later session is answered without starting anything.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnBackend } from "./backend.mjs";
import { createReader, encode, ensureRunDir } from "./lib.mjs";

const PROBE_TIMEOUT_MS = 30000;

function backendVersion(spec) {
  const script = spec.args?.find((a) => /cli\.m?js$/i.test(a));
  if (!script) return "unknown";
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(script)), "package.json"), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function probe(spec, initParams) {
  return new Promise((resolve, reject) => {
    const child = spawnBackend(spec, { stdio: ["pipe", "pipe", "ignore"] });
    const write = (msg) => { if (child.stdin.writable) child.stdin.write(encode(msg)); };
    const finish = (fn) => {
      clearTimeout(timer);
      write({ jsonrpc: "2.0", id: "tsd:bye", method: "shutdown" });
      write({ jsonrpc: "2.0", method: "exit" });
      setTimeout(() => { try { child.kill(); } catch {} }, 1000).unref();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("typescript-language-server did not answer initialize"))), PROBE_TIMEOUT_MS);
    child.on("error", (e) => finish(() => reject(e)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", createReader((msg) => {
      if (msg.id !== 1 || msg.method !== undefined) return;
      if (msg.error) finish(() => reject(new Error(msg.error.message ?? "initialize failed")));
      else finish(() => resolve(msg.result));
    }));
    write({ jsonrpc: "2.0", id: 1, method: "initialize", params: initParams });
  });
}

// `initParams` are what the router would send a project server for the
// session's own folder; the probe uses them so the answer matches what that
// server would have said.
export async function capabilitiesFor(spec, sessionParams, initParams, log = () => {}) {
  if (!spec) throw new Error("typescript-language-server is not installed: npm i -g typescript-language-server typescript@6");
  const key = createHash("sha1")
    .update(JSON.stringify([spec.describe, backendVersion(spec), sessionParams?.capabilities ?? null]))
    .digest("hex")
    .slice(0, 16);
  const file = path.join(ensureRunDir(), `capabilities-${key}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  log("learning capabilities from a probe server");
  const result = await probe(spec, initParams);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(result));
    fs.renameSync(tmp, file);
  } catch (e) {
    log("could not cache capabilities:", e.message);
  }
  return result;
}
