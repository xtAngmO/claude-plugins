import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanSource, splitTopLevel, matchBracket } from '../skills/security-audit/scripts/scan-serverfns.mjs';

const fixture = `
import { createServerFn } from '@tanstack/react-start'
import { authMiddleware, requirePermission, safeMiddleware } from '@/utils/permissions'

const manageUsers = requirePermission('manage_users')
const adminOnly = authMiddleware // looks like a guard, is only login

export const loginFn = createServerFn({ method: 'POST' })
	.middleware([safeMiddleware])
	.handler(async () => ({ ok: true }))

export const listUsersFn = createServerFn({ method: 'GET' })
	.middleware([manageUsers])
	.handler(async () => [])

export const adminConversationsFn = createServerFn({ method: "GET" })
	.middleware([adminOnly])
	.inputValidator((d: { q: string }) => d)
	.handler(async ({ data }) => { const s = \`x \${data.q} )\`; return s })

export const ownFilesFn = createServerFn({ method: 'POST' })
	.middleware([authMiddleware])
	.inputValidator<{ id: string }>((d) => d)
	.handler(async ({ data, context }) => {
		// a ")" in a comment and a "]" in a string must not confuse the scanner
		if (row.userId !== context.user.id) throw new Error('forbidden ]')
		return data
	})

export const inlineFn = createServerFn({ method: 'POST' })
	.middleware([safeMiddleware, requirePermission('manage_roles')])
	.handler(async () => null)
`;

test('classifies guards, follows same-file aliases, reads method and hints', () => {
	const rows = scanSource(fixture, 'fixture.ts');
	const by = Object.fromEntries(rows.map((r) => [r.name, r]));
	assert.equal(rows.length, 5);
	assert.equal(by.loginFn.klass, 'none');
	assert.equal(by.loginFn.method, 'POST');
	assert.equal(by.listUsersFn.klass, 'permission');
	assert.equal(by.listUsersFn.method, 'GET');
	assert.equal(by.adminConversationsFn.klass, 'auth-only', 'alias to authMiddleware is not a permission guard');
	assert.deepEqual(by.adminConversationsFn.middleware, ['adminOnly=>authMiddleware // looks like a guard, is only login']);
	assert.equal(by.ownFilesFn.klass, 'auth-only');
	assert.deepEqual(by.ownFilesFn.hints, ['checks-in-handler']);
	assert.equal(by.inlineFn.klass, 'permission');
	assert.equal(by.listUsersFn.line, 12);
});

test('regex literals with quotes or brackets do not derail the chain parser', () => {
	const src = `
export const autoNameFn = createServerFn({ method: 'POST' })
	.middleware([authMiddleware])
	.handler(async ({ data }) => {
		const raw = (data.text ?? '').trim().replace(/^["'\`(]+|["'\`)]+$/g, '')
		const half = data.total / 2 / data.count
		return raw
	})

export const nextFn = createServerFn({ method: 'GET' })
	.middleware([requirePermission('view_x')])
	.handler(async () => null)
`;
	const rows = scanSource(src, 'regex.ts');
	assert.deepEqual(rows.map((r) => [r.name, r.klass]), [['autoNameFn', 'auth-only'], ['nextFn', 'permission']]);
});

test('guard factories defined over several lines are followed into their body', () => {
	const src = `
const P = POLICIES
const readGuard = (policy: Policy) =>
	requireAnyPermission(policyPermissions(policy))
const callsGuard = readGuard(P.calls)
const loginOnly = (x: number) =>
	authMiddleware

export const listCallsFn = createServerFn({ method: 'GET' })
	.middleware([callsGuard])
	.handler(async () => [])

export const weakFn = createServerFn({ method: 'GET' })
	.middleware([loginOnly(1)])
	.handler(async () => [])
`;
	const by = Object.fromEntries(scanSource(src, 'factory.ts').map((r) => [r.name, r.klass]));
	assert.deepEqual(by, { listCallsFn: 'permission', weakFn: 'auth-only' });
});

test('splitTopLevel and matchBracket respect nesting, strings and templates', () => {
	assert.deepEqual(splitTopLevel(`a, b('x,y'), c([1, 2]), \`t,\${u}\``), ['a', "b('x,y')", 'c([1, 2])', '`t,${u}`']);
	const src = 'f(a, "(", `${g(")")}`, /* ) */ b)';
	assert.equal(matchBracket(src, 1), src.length - 1);
});
