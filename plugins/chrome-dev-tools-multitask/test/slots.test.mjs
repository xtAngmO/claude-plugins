import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSlots, profileBusyOn } from "../src/slots.mjs";

function home() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cdp-slots-"));
}

// Two "sessions" in one test process need different pids; everyone else's pid is alive.
const session = (h, pid, project, extra = {}) =>
  createSlots({ home: h, maxSlots: 3, project, pid, pidAlive: (p) => p !== 9999, profileBusy: () => false, ...extra });

test("the first browser gets slot 1, the profile chrome-devtools-mcp always used", () => {
  const h = home();
  try {
    const got = session(h, 100, null).claim();
    assert.deepEqual(got, { slot: 1, profile: path.join(h, "chrome-profile") });
    assert.equal(fs.readFileSync(path.join(h, "slots", "slot-1.lock"), "utf8"), "100");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a second browser at the same time gets its own slot and profile", () => {
  const h = home();
  try {
    const a = session(h, 100, "/a").claim();
    const b = session(h, 200, "/b").claim();
    assert.equal(a.slot, 1);
    assert.equal(b.slot, 2);
    assert.equal(b.profile, path.join(h, "profile-2"));
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a project gets its own profile back; a new project takes an unclaimed one first", () => {
  const h = home();
  try {
    let clock = 1;
    const now = () => clock++;
    const a = session(h, 100, "/a", { now });
    const first = a.claim();
    a.release(first.slot);
    const b = session(h, 200, "/b", { now }).claim();
    assert.notEqual(b.slot, first.slot, "b does not borrow a's profile while another is free");
    assert.equal(session(h, 300, "/a", { now }).claim().slot, first.slot, "a is back on its own profile");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("when every free slot belongs to another project, the one used longest ago is taken", () => {
  const h = home();
  try {
    let clock = 1;
    const now = () => clock++;
    for (const [pid, project] of [[1, "/x"], [2, "/y"], [3, "/z"]]) {
      const s = session(h, pid, project, { now });
      s.release(s.claim().slot);
    }
    const got = session(h, 4, "/new", { now }).claim();
    assert.equal(got.slot, 1, "/x used it first, longest ago");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a lock left by a dead holder is taken over; a live one is not", () => {
  const h = home();
  try {
    fs.mkdirSync(path.join(h, "slots"), { recursive: true });
    fs.writeFileSync(path.join(h, "slots", "slot-1.lock"), "9999"); // dead
    fs.writeFileSync(path.join(h, "slots", "slot-2.lock"), "4242"); // alive
    assert.equal(session(h, 100, null).claim().slot, 1);
    assert.equal(session(h, 200, null).claim().slot, 3);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a profile held by some other browser is skipped, and its lock given back", () => {
  const h = home();
  try {
    const busy = (profile) => profile.endsWith("chrome-profile");
    const got = session(h, 100, null, { profileBusy: busy }).claim();
    assert.equal(got.slot, 2);
    assert.equal(fs.existsSync(path.join(h, "slots", "slot-1.lock")), false);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("every slot taken: null, so the caller falls back to a throwaway profile", () => {
  const h = home();
  try {
    for (const pid of [1, 2, 3]) assert.ok(session(h, pid, null).claim());
    assert.equal(session(h, 4, null).claim(), null);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("release frees only its own lock", () => {
  const h = home();
  try {
    const a = session(h, 100, null);
    const got = a.claim();
    session(h, 200, null).release(got.slot); // not the holder
    assert.equal(fs.existsSync(path.join(h, "slots", "slot-1.lock")), true);
    a.release(got.slot);
    assert.equal(fs.existsSync(path.join(h, "slots", "slot-1.lock")), false);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a crashed Chrome's singleton files are cleared when its slot is claimed", () => {
  const h = home();
  try {
    const profile = path.join(h, "chrome-profile");
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, "SingletonLock"), "");
    assert.equal(session(h, 100, null).claim().profile, profile);
    assert.equal(fs.existsSync(path.join(profile, "SingletonLock")), false);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("the lock files are the standalone cdp-slot-chrome.mjs wrapper's: a pid, nothing else", () => {
  const h = home();
  try {
    session(h, 12345, "/p").claim();
    assert.equal(fs.readFileSync(path.join(h, "slots", "slot-1.lock"), "utf8"), "12345");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("macOS/Linux: a profile is busy while the browser its SingletonLock names is alive", () => {
  const busy = (target, { alive = true, hostname = "box" } = {}) =>
    profileBusyOn("linux", "/p", { readlink: () => target, pidAlive: () => alive, hostname });
  assert.equal(busy("box-4242"), true);
  assert.equal(busy("box-4242", { alive: false }), false, "a crashed browser's lock is stale");
  assert.equal(busy("my-host-4242", { hostname: "my-host" }), true, "a hostname with dashes splits at the last one");
  assert.equal(busy("other-4242"), true, "another machine's lock on a shared home cannot be checked: held");
  assert.equal(busy("garbage"), false);
  assert.equal(profileBusyOn("linux", "/p", { readlink: () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); } }), false, "no lock, no browser");
});

test("Windows: a profile whose lockfile is missing or openable is free", () => {
  const h = home();
  try {
    assert.equal(profileBusyOn("win32", h), false);
    fs.writeFileSync(path.join(h, "lockfile"), "");
    assert.equal(profileBusyOn("win32", h), false, "left behind by a browser that is gone");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("two sessions finding the same dead lock: only one takes it over", () => {
  const h = home();
  try {
    const slots = path.join(h, "slots");
    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(path.join(slots, "slot-1.lock"), "9999"); // dead
    // Another session is mid-takeover of that same dead lock right now.
    fs.writeFileSync(path.join(slots, "slot-1.lock.takeover-9999"), "300");
    const got = session(h, 100, null, { now: () => Date.now() }).claim();
    assert.equal(got.slot, 2, "backs off rather than both believing they hold slot 1");
    assert.equal(fs.readFileSync(path.join(slots, "slot-1.lock"), "utf8"), "9999", "left for the other taker");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});

test("a takeover token whose taker died is stale after 10 s and does not block the slot", () => {
  const h = home();
  try {
    const slots = path.join(h, "slots");
    fs.mkdirSync(slots, { recursive: true });
    fs.writeFileSync(path.join(slots, "slot-1.lock"), "9999");
    fs.writeFileSync(path.join(slots, "slot-1.lock.takeover-9999"), "300");
    const got = session(h, 100, null, { now: () => Date.now() + 60_000 }).claim();
    assert.equal(got.slot, 1);
    assert.equal(fs.readFileSync(path.join(slots, "slot-1.lock"), "utf8"), "100");
    assert.equal(fs.existsSync(path.join(slots, "slot-1.lock.takeover-9999")), false, "the token is cleaned up");
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
