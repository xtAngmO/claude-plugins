import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DialogWatch, questionKey } from "../src/dialog.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "answer-for-me-dialog-"));
const QUESTIONS = [{ question: "สีไหนดี?", header: "สี", multiSelect: false, options: [{ label: "แดง" }, { label: "น้ำเงิน" }] }];
const OTHER = [{ question: "Which size?", header: "Size", multiSelect: false, options: [{ label: "S" }, { label: "M" }] }];

const askLine = (id, questions = QUESTIONS) => JSON.stringify({
  type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name: "AskUserQuestion", input: { questions } }] },
}) + "\n";
const resultLine = (id) => JSON.stringify({
  type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "The user answered: ..." }] },
}) + "\n";
const noise = (n) => JSON.stringify({ type: "user", message: { role: "user", content: `hello ${n} ${"x".repeat(50)}` } }) + "\n";

test("questionKey: by question text only", () => {
  assert.equal(questionKey(QUESTIONS), questionKey([{ question: "สีไหนดี?", multiSelect: true }]));
  assert.notEqual(questionKey(QUESTIONS), questionKey(OTHER));
});

test("DialogWatch: open until the dialog's tool_result is appended", () => {
  const f = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(f, noise(1) + askLine("toolu_1"));
  const w = new DialogWatch(f, QUESTIONS);
  assert.equal(w.toolUseId, "toolu_1");
  assert.equal(w.answered(), false);
  fs.appendFileSync(f, noise(2) + resultLine("toolu_other"));
  assert.equal(w.answered(), false);
  fs.appendFileSync(f, resultLine("toolu_1"));
  assert.equal(w.answered(), true);
});

test("DialogWatch: a tool_result already there belongs to an earlier dialog", () => {
  const f = path.join(tmp(), "t.jsonl");
  // The same questions were asked and answered before; this dialog's tool_use is not written yet.
  fs.writeFileSync(f, askLine("toolu_old") + resultLine("toolu_old"));
  const w = new DialogWatch(f, QUESTIONS);
  assert.equal(w.answered(), false);
  fs.appendFileSync(f, askLine("toolu_new"));
  assert.equal(w.answered(), false);
  assert.equal(w.toolUseId, "toolu_new");
  fs.appendFileSync(f, resultLine("toolu_old"));
  assert.equal(w.answered(), false, "a stray result for the old id does not close the new dialog");
  fs.appendFileSync(f, resultLine("toolu_new"));
  assert.equal(w.answered(), true);
});

test("DialogWatch: other questions are not this dialog", () => {
  const f = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(f, askLine("toolu_1"));
  const w = new DialogWatch(f, QUESTIONS);
  fs.appendFileSync(f, askLine("toolu_2", OTHER) + resultLine("toolu_2"));
  assert.equal(w.answered(), false);
  assert.equal(w.toolUseId, "toolu_1");
});

test("DialogWatch: a line written in two pieces, split inside a UTF-8 character", () => {
  const f = path.join(tmp(), "t.jsonl");
  fs.writeFileSync(f, askLine("toolu_1"));
  const w = new DialogWatch(f, QUESTIONS);
  const bytes = Buffer.from(noise("ภาษาไทย") + resultLine("toolu_1"));
  const cut = Buffer.from(noise("ภาษาไทย")).indexOf(Buffer.from("ไ")) + 1; // inside a 3-byte character
  fs.appendFileSync(f, bytes.subarray(0, cut));
  assert.equal(w.answered(), false);
  fs.appendFileSync(f, bytes.subarray(cut, bytes.length - 5));
  assert.equal(w.answered(), false, "the result line is not complete yet");
  fs.appendFileSync(f, bytes.subarray(bytes.length - 5));
  assert.equal(w.answered(), true);
});

test("DialogWatch: a big transcript is read from its tail only", () => {
  const f = path.join(tmp(), "t.jsonl");
  let head = "";
  for (let i = 0; i < 200; i++) head += noise(i);
  fs.writeFileSync(f, head + askLine("toolu_1"));
  const w = new DialogWatch(f, QUESTIONS, { tailBytes: 2000 });
  assert.equal(w.toolUseId, "toolu_1");
  fs.appendFileSync(f, resultLine("toolu_1"));
  assert.equal(w.answered(), true);
});

test("DialogWatch: no transcript means never answered, and no throw", () => {
  assert.equal(new DialogWatch(undefined, QUESTIONS).answered(), false);
  assert.equal(new DialogWatch(path.join(tmp(), "missing.jsonl"), QUESTIONS).answered(), false);
});
