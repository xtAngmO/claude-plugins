// project.mjs — which TypeScript project a file belongs to.
//
// The unit tsserverd shares is the project, not the Claude Code session: every
// file is served by the tsserver of the nearest folder that has its own
// node_modules/typescript, whatever folder the session started in or `cd`ed to.
// So two sessions touching the same repo meet on one tsserver, and each repo is
// checked with the TypeScript it pins instead of whatever the session root has.
import fs from "node:fs";
import path from "node:path";
import { normalizeRoot, rootKey } from "./lib.mjs";

const TSSERVER = ["node_modules", "typescript", "lib", "tsserver.js"];

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const insideNodeModules = (dir) => dir.split(/[\\/]/).includes("node_modules");

// TypeScript 7 ships no tsserver.js, so it cannot be a project's TypeScript here:
// resolution keeps walking up past it.
function tsserverIn(dir) {
  const p = path.join(dir, ...TSSERVER);
  return isFile(p) ? p : null;
}

function gitRoot(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (exists(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

// `fallbackTsserver` is the TypeScript used for files no project claims (the
// global install next to typescript-language-server); injected so tests can
// run without one.
//
// Returns { root, tsserver, source: "project" | "global", flavor, key, library }.
// `library` marks a file that belongs to no project the user works on — the
// global TypeScript's own lib.*.d.ts, reached by go-to-definition — which the
// router hands to whatever project asked rather than starting a server for it.
export function createProjectResolver(fallbackTsserver) {
  const cache = new Map();
  const sameFile = (a, b) => Boolean(a && b) && normalizeRoot(a) === normalizeRoot(b);

  return function projectForDir(dir) {
    const start = path.resolve(dir);
    const cacheKey = normalizeRoot(start);
    const hit = cache.get(cacheKey);
    if (hit) return hit;

    for (let d = start; ; d = path.dirname(d)) {
      // A package inside node_modules is never a project of its own: a file in
      // node_modules/foo belongs to the project that installed foo.
      if (!insideNodeModules(d)) {
        const tsserver = tsserverIn(d);
        if (tsserver) {
          const library = insideNodeModules(start) && sameFile(tsserver, fallbackTsserver());
          const project = { root: d, tsserver, source: "project", flavor: "", key: rootKey(d), library };
          cache.set(cacheKey, project);
          return project;
        }
      }
      if (path.dirname(d) === d) break;
    }

    // No project TypeScript anywhere above: check with the global one, and
    // group by repository so those files still share a server. Not cached: an
    // `npm install` in the folder turns it into a project, and the next file
    // opened should find that out.
    let base = start;
    while (insideNodeModules(base) && path.dirname(base) !== base) base = path.dirname(base);
    const root = gitRoot(base) ?? base;
    return { root, tsserver: fallbackTsserver(), source: "global", flavor: "global", key: rootKey(root, "global"), library: false };
  };
}

// npm keeps global packages side by side, so the TypeScript that belongs with a
// global typescript-language-server is its sibling (or its own dependency).
export function siblingTsserver(backendSpec) {
  if (!backendSpec) return null;
  const script = backendSpec.args?.find((a) => /cli\.m?js$/i.test(a));
  if (!script) return null;
  const pkgDir = path.dirname(path.dirname(script));
  for (const candidate of [
    path.join(pkgDir, "node_modules", "typescript", "lib", "tsserver.js"),
    path.join(path.dirname(pkgDir), "typescript", "lib", "tsserver.js"),
  ]) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

export function typescriptVersionAt(tsserverPath) {
  if (!tsserverPath) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(path.dirname(tsserverPath), "..", "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}
