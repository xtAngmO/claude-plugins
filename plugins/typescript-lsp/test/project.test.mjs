import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createProjectResolver } from "../src/project.mjs";
import { rootKey } from "../src/lib.mjs";

const GLOBAL_TS = "/global/typescript/lib/tsserver.js";

function tree(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tsd-project-"));
  for (const rel of spec) {
    const p = path.join(root, rel);
    if (rel.endsWith("/")) fs.mkdirSync(p, { recursive: true });
    else { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ""); }
  }
  return root;
}

const TS = "node_modules/typescript/lib/tsserver.js";

test("a file belongs to the nearest folder with its own TypeScript", () => {
  const root = tree([`repo/${TS}`, "repo/src/deep/", "repo/.git/"]);
  try {
    const resolve = createProjectResolver(() => GLOBAL_TS);
    const p = resolve(path.join(root, "repo", "src", "deep"));
    assert.equal(p.root, path.join(root, "repo"));
    assert.equal(p.tsserver, path.join(root, "repo", ...TS.split("/")));
    assert.equal(p.source, "project");
    assert.equal(p.key, rootKey(path.join(root, "repo")));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a package inside node_modules belongs to the project that installed it", () => {
  const root = tree([`app/${TS}`, `app/node_modules/foo/${TS}`, "app/node_modules/foo/dist/"]);
  try {
    const p = createProjectResolver(() => GLOBAL_TS)(path.join(root, "app", "node_modules", "foo", "dist"));
    assert.equal(p.root, path.join(root, "app"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a nested package with its own TypeScript is its own project", () => {
  const root = tree([`mono/${TS}`, `mono/packages/web/${TS}`, "mono/packages/web/src/", "mono/packages/api/src/"]);
  try {
    const resolve = createProjectResolver(() => GLOBAL_TS);
    assert.equal(resolve(path.join(root, "mono", "packages", "web", "src")).root, path.join(root, "mono", "packages", "web"));
    assert.equal(resolve(path.join(root, "mono", "packages", "api", "src")).root, path.join(root, "mono"), "hoisted TypeScript");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("TypeScript 7 (no tsserver.js) is passed over", () => {
  const root = tree([`outer/${TS}`, "outer/ts7/node_modules/typescript/lib/tsc.js", "outer/ts7/src/"]);
  try {
    const p = createProjectResolver(() => GLOBAL_TS)(path.join(root, "outer", "ts7", "src"));
    assert.equal(p.root, path.join(root, "outer"));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("no project TypeScript: the global one, grouped by repository", () => {
  const root = tree(["repo/.git/", "repo/a/b/", "loose/x/"]);
  try {
    const resolve = createProjectResolver(() => GLOBAL_TS);
    const inRepo = resolve(path.join(root, "repo", "a", "b"));
    assert.equal(inRepo.root, path.join(root, "repo"));
    assert.equal(inRepo.tsserver, GLOBAL_TS);
    assert.equal(inRepo.source, "global");
    const loose = resolve(path.join(root, "loose", "x"));
    // tmpdir itself may sit inside a repository on some machines; only the
    // "not inside our tree" case is certain.
    assert.ok(loose.root === path.join(root, "loose", "x") || !loose.root.startsWith(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a folder without TypeScript is re-checked, so `npm install` turns it into a project", () => {
  const root = tree(["fresh/.git/", "fresh/src/"]);
  try {
    const resolve = createProjectResolver(() => GLOBAL_TS);
    const before = resolve(path.join(root, "fresh", "src"));
    assert.equal(before.source, "global");
    fs.mkdirSync(path.join(root, "fresh", "node_modules", "typescript", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "fresh", ...TS.split("/")), "");
    const after = resolve(path.join(root, "fresh", "src"));
    assert.equal(after.source, "project");
    assert.notEqual(after.key, before.key, "a different daemon: the old one pinned the global TypeScript");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the global TypeScript's own files are a library, not a project to start", () => {
  const root = tree([`prefix/${TS}`, "prefix/node_modules/typescript/lib/"]);
  try {
    const globalTs = path.join(root, "prefix", ...TS.split("/"));
    const p = createProjectResolver(() => globalTs)(path.join(root, "prefix", "node_modules", "typescript", "lib"));
    assert.equal(p.library, true);
    const own = createProjectResolver(() => GLOBAL_TS)(path.join(root, "prefix", "node_modules", "typescript", "lib"));
    assert.equal(own.library, false, "a project's own TypeScript is part of that project");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("answers are cached per folder", () => {
  const root = tree([`repo/${TS}`, "repo/src/"]);
  try {
    const resolve = createProjectResolver(() => GLOBAL_TS);
    const first = resolve(path.join(root, "repo", "src"));
    fs.rmSync(path.join(root, "repo", "node_modules"), { recursive: true });
    assert.equal(resolve(path.join(root, "repo", "src")), first);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
