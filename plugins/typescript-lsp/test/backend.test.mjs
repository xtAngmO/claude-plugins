import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveBackend } from "../src/backend.mjs";

const PKG = "typescript-language-server";

function fakeInstall(pkgDir) {
  fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: PKG, bin: { [PKG]: "lib/cli.mjs" } }));
  fs.writeFileSync(path.join(pkgDir, "lib", "cli.mjs"), "");
  return path.join(pkgDir, "lib", "cli.mjs");
}

function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-backend-"));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("npm on Windows: the package sits next to the launcher", () => withTemp((dir) => {
  // What %AppData%\npm looks like: the sh launcher, the .cmd, and node_modules.
  fs.writeFileSync(path.join(dir, PKG), "#!/bin/sh\n");
  fs.writeFileSync(path.join(dir, `${PKG}.cmd`), "@echo off\n");
  const cli = fakeInstall(path.join(dir, "node_modules", PKG));
  const spec = resolveBackend(["--stdio"], { PATH: dir });
  assert.deepEqual(spec, { command: process.execPath, args: [cli, "--stdio"], shell: false, describe: cli });
}));

test("npm elsewhere: <prefix>/bin with <prefix>/lib/node_modules", () => withTemp((dir) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const cli = fakeInstall(path.join(dir, "lib", "node_modules", PKG));
  assert.equal(resolveBackend([], { PATH: bin }).args[0], cli);
}));

test("bun: ~/.bun/bin with ~/.bun/install/global", () => withTemp((dir) => {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const cli = fakeInstall(path.join(dir, "install", "global", "node_modules", PKG));
  assert.equal(resolveBackend([], { PATH: bin }).args[0], cli);
}));

test("TSD_REAL_TLS wins, and a script path runs under node", () => withTemp((dir) => {
  const cli = fakeInstall(path.join(dir, "node_modules", PKG));
  const spec = resolveBackend(["--stdio"], { PATH: dir, TSD_REAL_TLS: "/opt/tls/cli.mjs" });
  assert.deepEqual(spec.args, ["/opt/tls/cli.mjs", "--stdio"]);
  assert.equal(spec.command, process.execPath);
  assert.notEqual(spec.describe, cli);
}));

test("only a launcher on PATH: use it", { skip: process.platform === "win32" && "unix launcher" }, () => withTemp((dir) => {
  fs.writeFileSync(path.join(dir, PKG), "#!/bin/sh\n");
  assert.deepEqual(resolveBackend(["--stdio"], { PATH: dir }), { command: path.join(dir, PKG), args: ["--stdio"], shell: false, describe: path.join(dir, PKG) });
}));

test("only a .cmd on PATH (Windows): run it through a shell, quoted", { skip: process.platform !== "win32" && "windows launcher" }, () => withTemp((dir) => {
  fs.writeFileSync(path.join(dir, PKG), "#!/bin/sh\n"); // never pick the sh script
  fs.writeFileSync(path.join(dir, `${PKG}.cmd`), "@echo off\n");
  const spec = resolveBackend(["--stdio"], { PATH: dir });
  assert.equal(spec.command, `"${path.join(dir, `${PKG}.cmd`)}"`);
  assert.equal(spec.shell, true);
}));

test("a .cmd under a path with a space actually runs (Windows)", { skip: process.platform !== "win32" && "windows launcher" }, () => withTemp((dir) => {
  const spaced = path.join(dir, "John Smith");
  fs.mkdirSync(spaced);
  const cmd = path.join(spaced, `${PKG}.cmd`);
  fs.writeFileSync(cmd, "@echo launched %1\r\n");
  const spec = resolveBackend(["--stdio"], { PATH: spaced });
  const out = spawnSync(spec.command, spec.args, { shell: spec.shell, encoding: "utf8", windowsHide: true });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /launched --stdio/);
}));

test("nothing installed: null", () => withTemp((dir) => {
  assert.equal(resolveBackend([], { PATH: dir }), null);
}));
