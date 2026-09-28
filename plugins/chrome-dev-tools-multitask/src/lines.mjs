// lines.mjs — MCP over stdio: one JSON-RPC message per line.
export function lineReader(onMessage, onBadLine = () => {}) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { onBadLine(line); continue; }
      onMessage(msg);
    }
  };
}

export const frame = (msg) => `${JSON.stringify(msg)}\n`;
