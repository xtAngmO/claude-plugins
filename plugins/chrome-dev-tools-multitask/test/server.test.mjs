import { test } from "node:test";
import assert from "node:assert/strict";
import { runsOnProfile, shellQuote } from "../src/server.mjs";

test("a browser is matched to its exact profile, not to one whose name merely starts the same", () => {
  const p = String.raw`C:\Users\me\.cache\chrome-devtools-mcp\chrome-profile`;
  assert.equal(runsOnProfile(String.raw`chrome.exe --user-data-dir=${p} --remote-debugging-pipe`, p, true), true);
  assert.equal(runsOnProfile(String.raw`chrome.exe --user-data-dir=${p}`, p, true), true, "at the end of the line");
  assert.equal(runsOnProfile(String.raw`chrome.exe --user-data-dir=${p}-beta --x`, p, true), false, "the official plugin's beta profile");
  const two = "/home/me/.cache/chrome-devtools-mcp/profile-2";
  assert.equal(runsOnProfile(`chrome --user-data-dir=${two}0 --x`, two, false), false, "profile-2 is not profile-20");
  assert.equal(runsOnProfile(`chrome --user-data-dir=${two} --x`, two, false), true);
});

test("quoted paths with spaces and non-ASCII names match", () => {
  const p = String.raw`C:\Users\José Name\.cache\chrome-devtools-mcp\profile-3`;
  assert.equal(runsOnProfile(`"chrome.exe" "--user-data-dir=${p}" --x`, p, true), true, "how Node quotes the whole argument on Windows");
  assert.equal(runsOnProfile(`"chrome.exe" "--user-data-dir=${p}-beta" --x`, p, true), false);
  assert.equal(runsOnProfile(`chrome.exe --user-data-dir="${p}" --x`, p, true), true);
});

test("case folds only where the file system does", () => {
  const p = String.raw`C:\Users\Me\chrome-profile`;
  assert.equal(runsOnProfile(String.raw`chrome.exe --user-data-dir=c:\users\me\CHROME-PROFILE`, p, true), true);
  assert.equal(runsOnProfile("chrome --user-data-dir=/Home/me/p", "/home/me/p", false), false);
});

test("regex characters in a profile path are taken literally", () => {
  const p = "/tmp/a+b(c)/p.1";
  assert.equal(runsOnProfile(`chrome --user-data-dir=${p}`, p, false), true);
  assert.equal(runsOnProfile("chrome --user-data-dir=/tmp/aab(c)/px1", p, false), false);
});

test("shell fallback quotes arguments that would otherwise split", () => {
  assert.deepEqual(shellQuote(["--yes", "--user-data-dir=C:\Users\A B\p", 'say "hi"']),
    ["--yes", '"--user-data-dir=C:\Users\A B\p"', '"say \\"hi\\""']);
});
