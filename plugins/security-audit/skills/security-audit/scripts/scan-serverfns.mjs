#!/usr/bin/env node
// Lists every TanStack Start server function (`createServerFn(...)...handler(...)`) and classifies it by the
// middleware that guards it:
//   permission  – at least one middleware looks like a permission/role check
//   auth-only   – only login/session middleware (logged-in is NOT authorized: review every one)
//   none        – no auth middleware at all (fine for login/locale cookies, a finding for anything else)
// Same-file aliases are followed (`const adminOnly = authMiddleware` is reported as auth-only, not as a guard).
// Handler bodies that check permissions/ownership themselves get the hint `checks-in-handler`.
//
// Usage: node scan-serverfns.mjs <repoRoot> [--src src] [--json]
//          [--permission-pattern <re>] [--auth-pattern <re>]
// Read-only: it only reads files. No dependencies; works with node >= 18 or bun.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PERMISSION_RE = /require(Any)?Permission|requireRole|requireAdmin|hasPermission|permission|manage[A-Z_]/i;
export const DEFAULT_AUTH_RE = /auth|session|login|requireUser|protected|signedIn/i;
const HANDLER_CHECK_RE = /assert\w*\(|require\w*Permission|hasPermission|\.userId\s*!==|!==\s*\w+\.userId|forbidden|unauthori[sz]ed|notOwner|ownerId/i;

/** Index of the bracket that closes the one at `open`, skipping strings, template literals and comments. */
export function matchBracket(src, open) {
	const pairs = { '(': ')', '[': ']', '{': '}' };
	const stack = [pairs[src[open]]];
	let i = open + 1;
	while (i < src.length && stack.length) {
		const c = src[i];
		const n = src[i + 1];
		if (c === '/' && n === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
		if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) return -1; i += 2; continue; }
		if (c === '"' || c === "'") { i = skipQuoted(src, i); continue; }
		if (c === '`') { i = skipTemplate(src, i); continue; }
		if (c === '/' && isRegexStart(src, i)) { i = skipRegex(src, i); continue; }
		if (pairs[c]) stack.push(pairs[c]);
		else if (c === stack[stack.length - 1]) stack.pop();
		i++;
	}
	return stack.length ? -1 : i - 1;
}

const REGEX_PRECEDING_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'throw', 'delete', 'new', 'yield', 'await']);

/** A `/` starts a regex literal (not a division) when it follows an operator, an opener, or a keyword. */
function isRegexStart(src, i) {
	let j = i - 1;
	while (j >= 0 && /\s/.test(src[j])) j--;
	if (j < 0) return true;
	const prev = src[j];
	if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
	if (/[\w$]/.test(prev)) {
		let k = j;
		while (k >= 0 && /[\w$]/.test(src[k])) k--;
		return REGEX_PRECEDING_WORDS.has(src.slice(k + 1, j + 1));
	}
	return false;
}

/** Index just past a regex literal starting at `i` (handles escapes, character classes and flags). */
function skipRegex(src, i) {
	let j = i + 1;
	let inClass = false;
	while (j < src.length) {
		const c = src[j];
		if (c === '\n') return i + 1; // not a regex after all; treat the slash as a plain character
		if (c === '\\') { j += 2; continue; }
		if (c === '[') inClass = true;
		else if (c === ']') inClass = false;
		else if (c === '/' && !inClass) break;
		j++;
	}
	j++;
	while (j < src.length && /[a-z]/i.test(src[j])) j++;
	return j;
}

function skipQuoted(src, i) {
	const q = src[i];
	i++;
	while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
	return i + 1;
}

function skipTemplate(src, i) {
	i++;
	while (i < src.length && src[i] !== '`') {
		if (src[i] === '\\') { i += 2; continue; }
		if (src[i] === '$' && src[i + 1] === '{') { const end = matchBracket(src, i + 1); if (end < 0) return src.length; i = end + 1; continue; }
		i++;
	}
	return i + 1;
}

function skipSpace(src, i) {
	for (;;) {
		while (i < src.length && /\s/.test(src[i])) i++;
		if (src.startsWith('//', i)) { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue; }
		if (src.startsWith('/*', i)) { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
		return i;
	}
}

/** Split a bracket's inner text on top-level commas. */
export function splitTopLevel(text) {
	const out = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"' || c === "'") { i = skipQuoted(text, i) - 1; continue; }
		if (c === '`') { i = skipTemplate(text, i) - 1; continue; }
		if ('([{'.includes(c)) depth++;
		else if (')]}'.includes(c)) depth--;
		else if (c === ',' && depth === 0) { out.push(text.slice(start, i).trim()); start = i + 1; }
	}
	const last = text.slice(start).trim();
	if (last) out.push(last);
	return out;
}

/** Parse the chain that starts at the `(` after `createServerFn`. */
export function parseChain(src, openParen) {
	const close = matchBracket(src, openParen);
	if (close < 0) return null;
	const opts = src.slice(openParen + 1, close);
	const calls = [];
	let i = close + 1;
	for (;;) {
		i = skipSpace(src, i);
		if (src[i] !== '.') return null;
		i = skipSpace(src, i + 1);
		const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
		if (!m) return null;
		const name = m[0];
		i = skipSpace(src, i + name.length);
		if (src[i] === '<') { // generic type args, e.g. .inputValidator<T>(...)
			let depth = 0;
			for (; i < src.length; i++) { if (src[i] === '<') depth++; else if (src[i] === '>' && --depth === 0) break; }
			i = skipSpace(src, i + 1);
		}
		if (src[i] !== '(') return null;
		const argClose = matchBracket(src, i);
		if (argClose < 0) return null;
		calls.push({ name, args: src.slice(i + 1, argClose) });
		i = argClose + 1;
		if (name === 'handler') return { opts, calls, end: i };
	}
}

/**
 * `const name = expr` for every const in the file. The expression may span lines
 * (`const guard = (p) =>\n\trequireAnyPermission(p)`): it runs until `;` or the next
 * line that starts at column 0 with something other than a closing bracket.
 */
export function collectAliases(src) {
	const map = new Map();
	const re = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*/g;
	let m;
	while ((m = re.exec(src))) {
		const rest = src.slice(re.lastIndex, re.lastIndex + 600);
		const end = rest.search(/;|\n(?=[^\s)\]}.])/);
		const expr = (end < 0 ? rest : rest.slice(0, end)).trim();
		if (!/createServerFn\s*\(/.test(expr)) map.set(m[1], expr);
	}
	return map;
}

/**
 * Follow aliases until something that isn't one. A call to a local helper
 * (`readGuard(P.calls)`) is resolved through the helper's own definition, so a
 * guard factory that wraps `requireAnyPermission` is recognised as a permission check.
 */
function resolveAlias(expr, aliases) {
	let cur = expr;
	const seen = new Set();
	for (let hop = 0; hop < 5; hop++) {
		const id = /^[A-Za-z_$][\w$]*$/.exec(cur)?.[0];
		const callee = id ? null : /^([A-Za-z_$][\w$]*)\s*\(/.exec(cur)?.[1];
		const next = id ?? callee;
		if (!next || seen.has(next) || !aliases.has(next)) break;
		seen.add(next);
		cur = id ? aliases.get(next) : `${cur} => ${aliases.get(next)}`;
	}
	return cur;
}

export function classifyMiddleware(items, aliases, { permissionRe = DEFAULT_PERMISSION_RE, authRe = DEFAULT_AUTH_RE } = {}) {
	const resolved = items.map((it) => ({ item: it, resolved: resolveAlias(it, aliases) }));
	// An alias that resolves to plain auth is auth even if its own name sounds like a permission ("adminOnly").
	const kinds = resolved.map(({ resolved: r }) => (permissionRe.test(r) ? 'permission' : authRe.test(r) ? 'auth' : 'other'));
	const klass = kinds.includes('permission') ? 'permission' : kinds.includes('auth') ? 'auth-only' : 'none';
	return { klass, resolved };
}

export function scanSource(src, file, options = {}) {
	const aliases = collectAliases(src);
	const rows = [];
	const re = /createServerFn\s*\(/g;
	let m;
	while ((m = re.exec(src))) {
		const before = src.slice(Math.max(0, m.index - 200), m.index);
		const name = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*$/.exec(before)?.[1] ?? '(anonymous)';
		const chain = parseChain(src, m.index + m[0].length - 1);
		if (!chain) continue;
		const method = /method\s*:\s*['"](\w+)['"]/.exec(chain.opts)?.[1]?.toUpperCase() ?? 'GET';
		const items = chain.calls.filter((c) => c.name === 'middleware').flatMap((c) => {
			const t = c.args.trim();
			return t.startsWith('[') ? splitTopLevel(t.slice(1, t.lastIndexOf(']'))) : [t];
		});
		const { klass, resolved } = classifyMiddleware(items, aliases, options);
		const handler = chain.calls.find((c) => c.name === 'handler')?.args ?? '';
		const line = src.slice(0, m.index).split('\n').length;
		rows.push({
			file, line, name, method, klass,
			middleware: resolved.map((r) => (r.item === r.resolved ? r.item : `${r.item}=>${r.resolved}`)),
			hints: HANDLER_CHECK_RE.test(handler) ? ['checks-in-handler'] : [],
		});
		re.lastIndex = chain.end;
	}
	return rows;
}

function walk(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walk(p, out);
		else if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !p.includes(`${path.sep}__tests__${path.sep}`)) out.push(p);
	}
	return out;
}

function parseArgs(argv) {
	const opts = { root: null, src: 'src', json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') opts.json = true;
		else if (a === '--src') opts.src = argv[++i];
		else if (a === '--permission-pattern') opts.permissionRe = new RegExp(argv[++i], 'i');
		else if (a === '--auth-pattern') opts.authRe = new RegExp(argv[++i], 'i');
		else if (!opts.root) opts.root = a;
	}
	return opts;
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (!opts.root) {
		console.error('usage: scan-serverfns.mjs <repoRoot> [--src src] [--json] [--permission-pattern re] [--auth-pattern re]');
		process.exit(2);
	}
	const base = path.resolve(opts.root, opts.src);
	const rows = walk(base).flatMap((f) => scanSource(fs.readFileSync(f, 'utf8'), path.relative(opts.root, f).split(path.sep).join('/'), opts));
	if (opts.json) { console.log(JSON.stringify(rows, null, 2)); return; }
	const count = (k) => rows.filter((r) => r.klass === k).length;
	console.log(`${rows.length} server functions: permission=${count('permission')} auth-only=${count('auth-only')} none=${count('none')}`);
	for (const klass of ['none', 'auth-only']) {
		console.log(`\n=== ${klass.toUpperCase()} ===`);
		for (const r of rows.filter((x) => x.klass === klass).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
			console.log(`${r.file}:${r.line}\t${r.name}\t${r.method}\t[${r.middleware.join(', ')}]\t${r.hints.join(',')}`);
		}
	}
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
