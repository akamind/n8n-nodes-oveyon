'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Oveyon } = require('../dist/nodes/Oveyon/Oveyon.node.js');
const { apiRequest, getMany, safeApiError } = require('../dist/nodes/Oveyon/GenericFunctions.js');
const { OveyonApi } = require('../dist/credentials/OveyonApi.credentials.js');
const UUID = '11111111-1111-4111-8111-111111111111';

function context(parameters, responses = [{ id: UUID, status: 'accepted' }], count = 1) {
	const calls = [];
	const ctx = {
		calls,
		getNode: () => ({ name: 'Oveyon', type: '@oveyon/n8n-nodes-oveyon.oveyon', typeVersion: 1, parameters: {}, position: [0, 0] }),
		getInputData: () => Array.from({ length: count }, () => ({ json: {} })),
		getNodeParameter: (name, i, fallback) => name in parameters ? (typeof parameters[name] === 'function' ? parameters[name](i) : parameters[name]) : fallback,
		continueOnFail: () => Boolean(parameters.continueOnFail),
		helpers: {
			httpRequestWithAuthentication: async function(credential, request) {
				assert.equal(this, ctx);
				calls.push({ credential, ...request });
				const response = responses.shift();
				if (response instanceof Error) throw response;
				return response?.statusCode ? response : { statusCode: 200, body: response, headers: {} };
			},
		},
	};
	return ctx;
}

test('API key is injected by the n8n credential, not a node parameter', () => {
	const credential = new OveyonApi();
	assert.equal(credential.properties[0].typeOptions.password, true);
	assert.match(credential.authenticate.properties.headers.Authorization, /\$credentials.apiKey/);
});

test('send maps recipients, text/html, sandbox, holds, and idempotency without automatic retries', async () => {
	const ctx = context({ resource: 'email', operation: 'send', from: 'Oveyon Test <sender@example.com>', to: 'one@example.com, two@example.com', subject: 'Synthetic test', text: 'Example', html: '<p>Example</p>', sendOptions: { cc: 'copy@example.com', bcc: 'blind@example.com', sandbox: true, hold: true, holdTtl: 3600, holdNote: 'Review', idempotencyKey: 'test-task-1' } });
	const result = await new Oveyon().execute.call(ctx);
	assert.equal(ctx.calls.length, 1);
	const call = ctx.calls[0];
	assert.equal(call.credential, 'oveyonApi');
	assert.equal(call.url, 'https://api.oveyon.com/v1/send');
	assert.equal(call.disableFollowRedirect, true);
	assert.equal(call.timeout, 30000);
	assert.equal(call.skipSslCertificateValidation, undefined);
	assert.deepEqual(call.body.to, ['one@example.com', 'two@example.com']);
	assert.equal(call.body.sandbox, true);
	assert.equal(call.body.idempotencyKey, 'test-task-1');
	assert.equal(call.body.holdTtl, 3600);
	assert.equal(result[0][0].json.status, 'accepted');
	assert.deepEqual(result[0][0].pairedItem, { item: 0 });
});

test('reply maps only its contract, never adds a sandbox request switch', async () => {
	const ctx = context({ resource: 'inbound', operation: 'reply', messageId: UUID, text: 'Synthetic reply', replyOptions: { from: 'inbox@example.com', subject: 'Response', idempotencyKey: 'reply-test-1', hold: true, sandbox: true } });
	await new Oveyon().execute.call(ctx);
	assert.equal(ctx.calls[0].url, `https://api.oveyon.com/v1/inbound/${UUID}/reply`);
	assert.equal(ctx.calls[0].body.sandbox, undefined);
	assert.equal(ctx.calls[0].body.hold, true);
});

for (const [resource, operation, suffix] of [['email', 'get', `messages/${UUID}`], ['inbound', 'get', `inbound/${UUID}`], ['inbound', 'getContent', `inbound/${UUID}/content`]]) {
	test(`${resource} ${operation} uses the expected fixed API path`, async () => {
		const ctx = context({ resource, operation, messageId: UUID, simplify: false }, [{ id: UUID, text: 'Preserved body' }]);
		const result = await new Oveyon().execute.call(ctx);
		assert.equal(ctx.calls[0].url, `https://api.oveyon.com/v1/${suffix}`);
		assert.equal(ctx.calls[0].method, 'GET');
		assert.equal(result[0][0].json.text, 'Preserved body');
	});
}

test('pagination follows next_cursor and preserves paired input indices', async () => {
	const first = Array.from({ length: 100 }, (_, i) => ({ id: `item-${i}` }));
	const ctx = context({ resource: 'inbound', operation: 'getMany', returnAll: false, limit: 101, simplify: false, filters: { sender: 'sender@example.com', untrustedField: 'ignored' } }, [{ data: first, next_cursor: 'i:next' }, { data: [{ id: 'last' }], next_cursor: null }]);
	const result = await new Oveyon().execute.call(ctx);
	assert.equal(result[0].length, 101);
	assert.equal(ctx.calls[1].qs.limit, 1);
	assert.equal(ctx.calls[1].qs.cursor, 'i:next');
	assert.equal(ctx.calls[0].qs.untrustedField, undefined);
	assert.deepEqual(result[0][100].pairedItem, { item: 0 });
});

test('repeated pagination cursor and empty pages fail instead of looping', async () => {
	for (const pages of [
		[{ data: [{ id: 'one' }], next_cursor: 'same' }, { data: [{ id: 'two' }], next_cursor: 'same' }],
		[{ data: [], next_cursor: 'next' }],
	]) {
		const ctx = context({}, pages);
		await assert.rejects(getMany.call(ctx, '/v1/messages', {}, true, 50), /cursor|empty page/);
		assert.ok(ctx.calls.length <= 2);
	}
});

test('return all follows the cursor past 10,000 items and stops at the last page', async () => {
	const pages = Array.from({ length: 101 }, (_, p) => ({ data: Array.from({ length: 100 }, (_, i) => ({ id: `${p}-${i}` })), next_cursor: `page-${p + 1}` }));
	pages.push({ data: [{ id: 'last' }], next_cursor: null });
	const ctx = context({}, pages);
	const items = await getMany.call(ctx, '/v1/messages', {}, true, 50);
	assert.equal(items.length, 10101);
	assert.equal(items[10100].id, 'last');
	assert.equal(ctx.calls.length, 102);
	assert.ok(ctx.calls.every(call => call.qs.limit === 100));
	assert.equal(ctx.calls[0].qs.cursor, undefined);
	assert.equal(ctx.calls[101].qs.cursor, 'page-101');
});

test('a cursor saved by the removed Cursor filter is ignored', async () => {
	const ctx = context({ resource: 'email', operation: 'getMany', returnAll: false, limit: 10, simplify: false, filters: { cursor: 'stale-cursor', sender: 'sender@example.com' } }, [{ data: [{ id: 'one' }], next_cursor: null }]);
	const result = await new Oveyon().execute.call(ctx);
	assert.equal(result[0].length, 1);
	assert.equal(ctx.calls.length, 1);
	assert.equal(ctx.calls[0].qs.cursor, undefined);
	assert.equal(ctx.calls[0].qs.sender, 'sender@example.com');
});

test('action node has no notices and no user-facing cursor; reply explains sandbox in its description', () => {
	const properties = new Oveyon().description.properties;
	assert.deepEqual(properties.filter(property => property.type === 'notice').map(property => property.name), []);
	const filters = properties.find(property => property.name === 'filters');
	assert.equal(filters.options.some(option => option.name === 'cursor'), false);
	const reply = properties.filter(property => property.name === 'operation').flatMap(property => property.options).find(option => option.value === 'reply');
	assert.match(reply.description, /sandbox status of the API key/);
	assert.match(reply.description, /sandbox API key to test without delivery/);
});

test('simplify preserves inbound quarantine and authentication context', async () => {
	const data = { id: UUID, authentication: { dmarc: 'pass' }, agentSafety: { verdict: 'dangerous' }, quarantine: { reason: 'held' }, recipients: [{ to: 'inbox@example.com', outcome: 'quarantined' }], outcome: 'quarantined', privateExtra: 'removed' };
	const ctx = context({ resource: 'inbound', operation: 'get', messageId: UUID, simplify: true }, [data]);
	const item = (await new Oveyon().execute.call(ctx))[0][0].json;
	assert.equal(item.privateExtra, undefined);
	assert.deepEqual(item.agentSafety, data.agentSafety);
	assert.deepEqual(item.recipients, data.recipients);
});

test('unsafe IDs and paths fail before any authenticated request', async () => {
	for (const id of ['../messages', 'https://example.com/', `${UUID}?x=1`, '%2fsecret']) {
		const ctx = context({ resource: 'email', operation: 'get', messageId: id });
		await assert.rejects(new Oveyon().execute.call(ctx), /UUID/);
		assert.equal(ctx.calls.length, 0);
	}
	const ctx = context({});
	await assert.rejects(apiRequest.call(ctx, 'GET', '/v1/messages/../../'), /resource path/);
	assert.equal(ctx.calls.length, 0);
});

test('input validation prevents writes for invalid bodies and idempotency keys', async () => {
	for (const extra of [{ text: '', html: '' }, { subject: 'Subject\r\nInjected: yes' }, { sendOptions: { idempotencyKey: 'bad key' } }, { sendOptions: { sandbox: 'true' } }]) {
		const ctx = context({ resource: 'email', operation: 'send', from: 'sender@example.com', to: 'one@example.com', text: 'Example', ...extra });
		await assert.rejects(new Oveyon().execute.call(ctx));
		assert.equal(ctx.calls.length, 0);
	}
});

test('failed writes are not retried and raw transport errors do not escape', async () => {
	const marker = 'SYNTHETIC-SECRET-DO-NOT-ECHO';
	const ctx = context({ resource: 'inbound', operation: 'reply', messageId: UUID, text: 'Example' }, [new Error(`Authorization: Bearer ${marker}`)]);
	await assert.rejects(new Oveyon().execute.call(ctx), (error) => !JSON.stringify(error).includes(marker) && /result of a write may be unknown/.test(error.message));
	assert.equal(ctx.calls.length, 1);
});

test('continue on fail emits a safe error with the original item index', async () => {
	const ctx = context({ resource: 'email', operation: 'get', messageId: i => i === 0 ? 'bad' : UUID, continueOnFail: true }, [{ id: UUID }], 2);
	const results = (await new Oveyon().execute.call(ctx))[0];
	assert.match(results[0].json.error, /UUID/);
	assert.deepEqual(results[1].pairedItem, { item: 1 });
});

test('unknown remote error strings are never reflected', () => {
	assert.doesNotMatch(safeApiError(422, { error: 'SYNTHETIC-SECRET', message: 'SYNTHETIC-SECRET' }), /SYNTHETIC-SECRET/);
	assert.match(safeApiError(429, { error: 'rate_limited' }, { 'retry-after': '60' }), /at least 60 seconds/);
	assert.match(safeApiError(302, {}), /redirect refused/);
});

test('credential test uses a read-only fixed request and explains limited scopes', () => {
 const definition = new OveyonApi().test;
 assert.equal(definition.request.url, 'https://api.oveyon.com/v1/messages');
 assert.equal(definition.request.method, 'GET');
 assert.deepEqual(definition.request.qs, { limit: 1 });
 assert.equal(definition.request.disableFollowRedirect, true);
 assert.equal(definition.request.ignoreHttpStatusErrors.ignore, true);
 for (let status = 100; status <= 999; status++) assert.equal(definition.request.ignoreHttpStatusErrors.except.includes(status), status !== 200);
 assert.equal(definition.request.skipSslCertificateValidation, undefined);
 assert.match(definition.rules.find(rule => rule.properties.value === 403).properties.message, /read:messages/);
 assert.match(definition.rules.find(rule => rule.properties.value === 403).properties.message, /can still use Send/);
});
