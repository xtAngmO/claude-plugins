// shim.mjs — what Claude Code spawns (see .lsp.json), one per session. It speaks
// LSP on stdio like typescript-language-server, and routes each file the
// session touches to the shared server of that file's project (router.mjs).
//
//   TSD_DISABLE=1              behave exactly like typescript-language-server
//   TSD_PROJECT_IDLE_MS        release a project unused this long (default 15 min)
//   TSD_SYNTAX_SERVER=auto     keep typescript-language-server's second, syntax-only
//                              tsserver (default: off — it only speeds up the first
//                              seconds of a project load, for ~150 MB each)
//   TSD_TYPE_ACQUISITION=on    download @types for plain JS projects (default off)
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolveBackend, spawnBackend } from "./backend.mjs";
import { capabilitiesFor } from "./capabilities.mjs";
import { createLogger, createReader, encode, isAlive } from "./lib.mjs";
import { ProjectLink } from "./link.mjs";
import { createProjectResolver, siblingTsserver } from "./project.mjs";
import { Router } from "./router.mjs";

const ARGS = process.argv.slice(2);
const log = createLogger("shim");
const positiveInt = (v) => (/^\d+$/.test(String(v ?? "")) && Number(v) > 0 ? Number(v) : undefined);
const PROJECT_IDLE_MS = positiveInt(process.env.TSD_PROJECT_IDLE_MS) ?? 15 * 60 * 1000;
const IDLE_CHECK_MS = positiveInt(process.env.TSD_IDLE_CHECK_MS) ?? 60 * 1000;
const SYNTAX_SERVER = process.env.TSD_SYNTAX_SERVER === "auto" ? "auto" : "never";
const TYPE_ACQUISITION = process.env.TSD_TYPE_ACQUISITION === "on";

if (process.env.TSD_DISABLE) {
  passthrough();
} else {
  route();
}

function passthrough() {
  const spec = resolveBackend(ARGS);
  log("running typescript-language-server directly: TSD_DISABLE is set");
  if (!spec) { log("typescript-language-server not found"); process.exit(1); }
  const child = spawnBackend(spec, { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (e) => { log("could not start it:", e.message); process.exit(1); });
}

function route() {
  const spec = resolveBackend(ARGS);
  const projectForDir = createProjectResolver(() => siblingTsserver(spec));

  // What a project's server is told at initialize: the session's own params,
  // re-rooted at the project and pinned to the project's TypeScript.
  const initParamsFor = (project, session) => {
    const uri = pathToFileURL(project.root).href;
    const options = session.initializationOptions ?? {};
    return {
      ...session,
      processId: session.processId ?? process.pid,
      rootUri: uri,
      rootPath: project.root,
      workspaceFolders: [{ uri, name: path.basename(project.root) }],
      initializationOptions: {
        ...options,
        tsserver: {
          ...(options.tsserver ?? {}),
          ...(project.tsserver ? { path: project.tsserver } : {}),
          useSyntaxServer: SYNTAX_SERVER,
        },
        disableAutomaticTypingAcquisition: !TYPE_ACQUISITION,
      },
    };
  };

  const sessionRoot = (params) => {
    const uri = params.rootUri ?? params.workspaceFolders?.[0]?.uri;
    if (uri) { try { return fileURLToPath(uri); } catch {} }
    return params.rootPath || process.cwd();
  };

  const router = new Router({
    toClient: (msg) => process.stdout.write(encode(msg)),
    projectForFile: (file) => projectForDir(path.dirname(file)),
    makeLink: (project, hooks) => new ProjectLink({
      project,
      args: ARGS,
      log,
      initParams: (p) => initParamsFor(p, router.session ?? {}),
      ...hooks,
    }),
    capabilities: (session) => {
      watchSession(session.processId);
      return capabilitiesFor(spec, session, initParamsFor(projectForDir(sessionRoot(session)), session), log);
    },
    log,
    onExit: (code) => setTimeout(() => process.exit(code), 50),
    projectIdleMs: PROJECT_IDLE_MS,
  });

  const read = createReader((msg) => router.fromClient(msg));
  const end = () => { router.close(); setTimeout(() => process.exit(0), 50); };
  process.stdin.on("data", read);
  process.stdin.on("end", end);
  process.stdin.on("error", end);
  setInterval(() => router.tick(Date.now()), IDLE_CHECK_MS).unref();

  // Nothing downstream watches the session's pid any more (daemons watch
  // themselves), so the shim notices a session that dies without saying goodbye.
  let watching = false;
  function watchSession(pid) {
    if (watching || !Number.isInteger(pid)) return;
    watching = true;
    setInterval(() => {
      if (isAlive(pid)) return;
      log("session", pid, "is gone");
      end();
    }, 5000).unref();
  }
}
