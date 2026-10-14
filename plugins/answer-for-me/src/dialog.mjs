// dialog.mjs — has the user already answered this AskUserQuestion dialog?
//
// Claude Code runs the PermissionRequest hook alongside the dialog and does not
// stop it when the user answers: it is tied to the turn, not to the dialog
// (checked on 2.1.296). So the hook watches the session's transcript itself.
// The dialog's tool_use is the latest AskUserQuestion with the same questions;
// once a tool_result for that id is appended, the dialog is closed.
//
// The hook starts before the dialog is shown, so a tool_result already in the
// transcript at that moment belongs to an earlier dialog and is ignored.
// The file is read incrementally from where the last read stopped. Lines are
// split on "\n" bytes, which never occur inside a UTF-8 sequence.
import fs from "node:fs";

const TAIL_BYTES = 8 * 1024 * 1024;

export function questionKey(questions) {
  return JSON.stringify((questions || []).map((q) => q?.question ?? ""));
}

export class DialogWatch {
  constructor(file, questions, { tailBytes = TAIL_BYTES } = {}) {
    this.file = file || null;
    this.key = questionKey(questions);
    this.toolUseId = null;
    this.closed = false;
    this.offset = 0;
    this.rest = Buffer.alloc(0);
    this.skipPartial = false;
    if (!this.file) return;
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { return; }
    this.offset = Math.max(0, size - tailBytes);
    this.skipPartial = this.offset > 0;
    this.#read(true);
  }

  // True once the user (or anything else) answered the dialog.
  answered() {
    if (!this.closed && this.file) this.#read(false);
    return this.closed;
  }

  #read(initial) {
    let size;
    try { size = fs.statSync(this.file).size; } catch { return; }
    if (size < this.offset) { this.offset = 0; this.rest = Buffer.alloc(0); this.skipPartial = false; }
    if (size === this.offset) return;
    const chunk = Buffer.alloc(size - this.offset);
    let fd;
    try {
      fd = fs.openSync(this.file, "r");
      const n = fs.readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset += n;
    } catch { return; } finally { if (fd !== undefined) fs.closeSync(fd); }
    let buf = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    if (this.skipPartial) {
      const nl = buf.indexOf(10);
      if (nl < 0) { this.rest = buf; return; }
      buf = buf.subarray(nl + 1);
      this.skipPartial = false;
    }
    const last = buf.lastIndexOf(10);
    if (last < 0) { this.rest = buf; return; }
    this.rest = Buffer.from(buf.subarray(last + 1));
    for (const line of buf.subarray(0, last).toString("utf8").split("\n")) this.#line(line, initial);
  }

  #line(line, initial) {
    const mentionsAsk = line.includes("AskUserQuestion");
    const mentionsId = this.toolUseId !== null && line.includes(this.toolUseId);
    if (!mentionsAsk && !mentionsId) return;
    let e;
    try { e = JSON.parse(line); } catch { return; }
    const content = e?.message?.content;
    if (!Array.isArray(content)) return;
    for (const c of content) {
      if (c?.type === "tool_use" && c.name === "AskUserQuestion" && questionKey(c.input?.questions) === this.key) {
        this.toolUseId = c.id;
        this.closed = false;
      } else if (!initial && c?.type === "tool_result" && this.toolUseId !== null && c.tool_use_id === this.toolUseId) {
        this.closed = true;
      }
    }
  }
}
