'use strict';
// Get Many pagination (0.2.0): Limit, Return All without a ceiling, cursor guards and the read retry.
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeHelpers } = require('n8n-workflow');
const { Oveyon } = require('../dist/nodes/Oveyon/Oveyon.node.js');
const { getMany, safeApiError } = require('../dist/nodes/Oveyon/GenericFunctions.js');

function context(parameters, responses) {
	const calls = [];
	const ctx = {
		calls,
		getNode: () => ({ name: 'Oveyon', type: '@oveyon/n8n-nodes-oveyon.oveyon', typeVersion: 1, parameters: {}, position: [0, 0] }),
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, i, fallback) => (name in parameters ? parameters[name] : fallback),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async function (credential, request) {
				calls.push({ credential, ...request });
				const response = responses.shift();
				return response?.statusCode ? response : { statusCode: 200, body: response, headers: {} };
			},
		},
	};
	return ctx;
}
const page = (n, next, prefix = 'i') => ({ data: Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` })), next_cursor: next });

test('Limit is still validated when Return All is off, before any request', async () => {
	for (const limit of [0, -1, 10001, 1.5, Number.NaN, '50', undefined]) {
		const ctx = context({}, [page(1, null)]);
		await assert.rejects(getMany.call(ctx, '/v1/messages', {}, false, limit), /Limit must be between 1 and 10000/, String(limit));
		assert.equal(ctx.calls.length, 0, String(limit));
	}
	const ctx = context({ resource: 'email', operation: 'getMany', returnAll: false, limit: 10001 }, [page(1, null)]);
	await assert.rejects(new Oveyon().execute.call(ctx), /Limit must be between 1 and 10000/);
	assert.equal(ctx.calls.length, 0);
});

test('Return All ignores a stale or out-of-range Limit', async () => {
	for (const limit of [0, 10001, undefined, Number.NaN]) {
		const ctx = context({}, [page(3, null)]);
		const items = await getMany.call(ctx, '/v1/messages', {}, true, limit);
		assert.equal(items.length, 3, String(limit));
		assert.equal(ctx.calls[0].qs.limit, 100, String(limit));
	}
});

test('Limit reached with a cursor still pending stops without another request', async () => {
	let ctx = context({}, [page(50, 'more')]);
	let items = await getMany.call(ctx, '/v1/messages', {}, false, 50);
	assert.equal(items.length, 50);
	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.calls[0].qs.limit, 50);
	ctx = context({}, [page(100, 'c1', 'a'), page(100, 'c2', 'b'), page(50, 'c3', 'c')]);
	items = await getMany.call(ctx, '/v1/inbound', {}, false, 250);
	assert.equal(items.length, 250);
	assert.deepEqual(ctx.calls.map((call) => [call.qs.limit, call.qs.cursor]), [[100, undefined], [100, 'c1'], [50, 'c2']]);
});

test('invalid cursor values fail before being sent, in both modes', async () => {
	for (const returnAll of [true, false]) {
		for (const bad of [42, true, {}, ['x'], 'x'.repeat(2049)]) {
			const ctx = context({}, [page(1, bad), page(1, null)]);
			await assert.rejects(getMany.call(ctx, '/v1/messages', {}, returnAll, 50), /Invalid or repeated pagination cursor/, JSON.stringify(bad).slice(0, 20));
			assert.equal(ctx.calls.length, 1);
		}
	}
});

test('a cursor repeated after other pages (A, B, A) is refused', async () => {
	const ctx = context({}, [page(1, 'A', 'p1'), page(1, 'B', 'p2'), page(1, 'A', 'p3'), page(1, null, 'p4')]);
	await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /repeated pagination cursor/);
	assert.equal(ctx.calls.length, 3);
});

test('empty-string or absent next_cursor ends Return All', async () => {
	for (const last of [{ data: [{ id: 'z' }], next_cursor: '' }, { data: [{ id: 'z' }] }, { data: [], next_cursor: null }]) {
		const ctx = context({}, [page(100, 'c1'), last]);
		const items = await getMany.call(ctx, '/v1/messages', {}, true, 50);
		assert.equal(ctx.calls.length, 2);
		assert.equal(items.length, 100 + last.data.length);
	}
});

test('more items than requested are refused in both modes', async () => {
	let ctx = context({}, [page(6, null)]);
	await assert.rejects(getMany.call(ctx, '/v1/messages', {}, false, 5), /more items than requested/);
	ctx = context({}, [page(101, null)]);
	await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /more items than requested/);
});

test('the n8n editor drops a saved Cursor filter without parameter issues', () => {
	const description = new Oveyon().description;
	const saved = { resource: 'email', operation: 'getMany', returnAll: false, limit: 25, filters: { cursor: 'stale', sender: 'a@example.com' } };
	const node = { name: 'Oveyon', type: '@oveyon/n8n-nodes-oveyon.oveyon', typeVersion: 1, position: [0, 0], parameters: saved };
	const values = NodeHelpers.getNodeParameters(description.properties, saved, false, false, node, description);
	assert.deepEqual(values.filters, { sender: 'a@example.com' });
	assert.equal(NodeHelpers.getNodeParametersIssues(description.properties, node, description), null);
});

test('bad_cursor help does not point to the removed Cursor filter', () => {
	const message = safeApiError(400, { error: 'bad_cursor' });
	assert.match(message, /bad_cursor/);
	assert.doesNotMatch(message, /cursor filter/i);
});

const limited = (code = 'rate_limited', retryAfter = '0') => ({ statusCode: 429, body: { error: code }, headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter } });

test('a rate-limited read waits and repeats the same page, keeping what was already read', async () => {
	const ctx = context({}, [page(100, 'c1', 'a'), limited(), limited(), page(1, null, 'b')]);
	const items = await getMany.call(ctx, '/v1/inbound', {}, true, 50);
	assert.equal(items.length, 101);
	assert.deepEqual(ctx.calls.map((call) => call.qs.cursor), [undefined, 'c1', 'c1', 'c1']);
});

test('the read retry stops after three consecutive rate limits with the sanitised error', async () => {
	const ctx = context({}, [page(100, 'c1'), limited(), limited(), limited(), limited(), page(1, null)]);
	await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /HTTP 429\): rate_limited/);
	assert.equal(ctx.calls.length, 5);
});

test('only rate_limited is retried; other 429 codes fail at once', async () => {
	for (const code of ['too_many_auth_failures', 'quota_exceeded', 'something_else']) {
		const ctx = context({}, [limited(code), page(1, null)]);
		await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /HTTP 429/, code);
		assert.equal(ctx.calls.length, 1, code);
	}
});

test('writes are never retried on a rate limit', async () => {
	const ctx = context({ resource: 'email', operation: 'send', from: 'sender@example.com', to: 'one@example.com', subject: 'Synthetic test', text: 'Example', sendOptions: {} }, [limited(), { id: 'x', status: 'accepted' }]);
	await assert.rejects(new Oveyon().execute.call(ctx), /HTTP 429\): rate_limited/);
	assert.equal(ctx.calls.length, 1);
});

test('Return All must be a real boolean, not a truthy string', async () => {
	for (const returnAll of ['false', 'true', 1, null]) {
		const ctx = context({ resource: 'email', operation: 'getMany', returnAll, limit: 10 }, [page(1, null)]);
		await assert.rejects(new Oveyon().execute.call(ctx), /Return All must be a boolean/, String(returnAll));
		assert.equal(ctx.calls.length, 0);
	}
});

// The wait itself: what Oveyon asks, capped at 60 s, 60 s when absent or not in seconds.
function waitContext(responses, cancelSignal) {
	const calls = [];
	const ctx = {
		calls,
		getExecutionCancelSignal: () => cancelSignal,
		getNode: () => ({ name: 'Oveyon', type: '@oveyon/n8n-nodes-oveyon.oveyon', typeVersion: 1, parameters: {}, position: [0, 0] }),
		helpers: {
			httpRequestWithAuthentication: async function (credential, request) {
				calls.push(request);
				const response = responses.shift();
				return response?.statusCode ? response : { statusCode: 200, body: response, headers: {} };
			},
		},
	};
	return ctx;
}

test('the read retry waits Retry-After seconds, capped at 60, and 60 when absent or not in seconds', async (t) => {
	const realSetTimeout = globalThis.setTimeout;
	for (const [header, expected] of [['7', 7000], ['0', 0], ['600', 60000], [undefined, 60000], ['Wed, 21 Oct 2026 07:28:00 GMT', 60000], ['1.5', 60000]]) {
		const delays = [];
		const spy = t.mock.method(globalThis, 'setTimeout', (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, 0, ...rest); });
		const ctx = waitContext([{ statusCode: 429, body: { error: 'rate_limited' }, headers: header === undefined ? {} : { 'retry-after': header } }, { data: [{ id: 'a' }], next_cursor: null }]);
		const items = await getMany.call(ctx, '/v1/messages', {}, true, 50);
		spy.mock.restore();
		assert.equal(items.length, 1, String(header));
		assert.deepEqual(delays, [expected], String(header));
		assert.equal(ctx.calls.length, 2);
	}
});

test('rate_limited in a non-429 response is not retried', async () => {
	for (const statusCode of [503, 400, 200]) {
		const ctx = waitContext([{ statusCode, body: { error: 'rate_limited' }, headers: { 'retry-after': '0' } }, { data: [{ id: 'a' }], next_cursor: null }]);
		await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), undefined, String(statusCode));
		assert.equal(ctx.calls.length, 1, String(statusCode));
	}
});

test('stopping the execution ends a rate-limit wait at once', async () => {
	const stop = new AbortController();
	stop.abort(new Error('execution cancelled'));
	const ctx = waitContext([{ statusCode: 429, body: { error: 'rate_limited' }, headers: { 'retry-after': '60' } }, { data: [{ id: 'a' }], next_cursor: null }], stop.signal);
	const started = Date.now();
	await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /execution cancelled/);
	assert.ok(Date.now() - started < 5000);
	assert.equal(ctx.calls.length, 1);
});
