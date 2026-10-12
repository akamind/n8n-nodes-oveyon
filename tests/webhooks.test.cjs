'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { validateWebhook, DELIVERY_EVENTS, MAX_WEBHOOK_BYTES } = require('../dist/nodes/Oveyon/WebhookFunctions.js');
const { OveyonTrigger, testSigningSecret } = require('../dist/nodes/Oveyon/OveyonTrigger.node.js');
const SECRET = 'a'.repeat(64); // Synthetic fixture, not an Oveyon credential.
const NOW = 1800000000;
const inbound = { event: 'inbound.received', eventId: '11111111-1111-4111-8111-111111111111', message: { id: '22222222-2222-4222-8222-222222222222' }, text: 'Synthetic email' };
const challenge = { type: 'url_verification', challenge: 'b'.repeat(64), url: 'https://example.com/webhook', sentAt: new Date(NOW * 1000).toISOString() };

function signed(body = inbound, changes = {}) {
	const rawBody = Buffer.from(JSON.stringify(body));
	const timestamp = String(NOW);
	return { rawBody, family: 'inbound', mode: 'live', secret: SECRET, events: DELIVERY_EVENTS, now: NOW, headers: { 'content-type': 'application/json; charset=utf-8', 'x-oveyon-event': body.event || body.type, 'x-oveyon-timestamp': timestamp, 'x-oveyon-signature': `sha256=${createHmac('sha256', SECRET).update(timestamp).update('.').update(rawBody).digest('hex')}` }, ...changes };
}

test('setup echoes only the bounded, typed challenge and emits no event', () => {
	const input = signed(challenge, { mode: 'setup', secret: undefined });
	delete input.headers['x-oveyon-signature'];
	assert.deepEqual(validateWebhook(input), { status: 200, response: { challenge: challenge.challenge } });
	const business = validateWebhook(signed(inbound, { mode: 'setup' }));
	assert.equal(business.status, 503);
	assert.equal(business.event, undefined);
});

test('live verifies the initial/repeated challenge as well as business events', () => {
	assert.deepEqual(validateWebhook(signed(challenge)), { status: 200, response: { challenge: challenge.challenge } });
	const missing = signed(challenge);
	delete missing.headers['x-oveyon-signature'];
	assert.equal(validateWebhook(missing).status, 401);
	assert.deepEqual(validateWebhook(signed()).event, inbound);
});

for (const event of DELIVERY_EVENTS) {
	test(`delivery event ${event} preserves its original payload`, () => {
		const body = { event, messageId: 'synthetic-message', timestamp: new Date(NOW * 1000).toISOString(), detail: { marker: 'test' } };
		assert.deepEqual(validateWebhook(signed(body, { family: 'delivery' })).event, body);
	});
}

for (const [name, mutate, status] of [
	['missing secret', input => { delete input.secret; }, 503],
	['invalid secret format', input => { input.secret = 'bad'; }, 503],
	['missing raw bytes', input => { delete input.rawBody; }, 400],
	['string body is not raw bytes', input => { input.rawBody = input.rawBody.toString(); }, 400],
	['tampered bytes', input => { input.rawBody = Buffer.concat([input.rawBody, Buffer.from(' ')]); }, 401],
	['malformed signature', input => { input.headers['x-oveyon-signature'] = 'sha256=0'; }, 401],
	['missing signature', input => { delete input.headers['x-oveyon-signature']; }, 401],
	['duplicate signature header', input => { input.headers['x-oveyon-signature'] = ['a', 'b']; }, 401],
	['past timestamp', input => { input.now = NOW + 301; }, 401],
	['future timestamp', input => { input.now = NOW - 301; }, 401],
	['missing timestamp', input => { delete input.headers['x-oveyon-timestamp']; }, 401],
	['wrong content type', input => { input.headers['content-type'] = 'text/plain'; }, 415],
	['header/body event mismatch', input => { input.headers['x-oveyon-event'] = 'delivered'; }, 400],
	['wrong family', input => { input.family = 'delivery'; }, 400],
	['oversized payload', input => { input.rawBody = Buffer.alloc(MAX_WEBHOOK_BYTES + 1); }, 413],
]) {
	test(`rejects ${name}`, () => {
		const input = signed(); mutate(input);
		const result = validateWebhook(input);
		assert.equal(result.status, status);
		assert.equal(result.event, undefined);
		assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET));
	});
}

test('exact age limit is accepted and malformed JSON never emits an event', () => {
	assert.equal(validateWebhook(signed(inbound, { now: NOW + 300 })).status, 200);
	const input = signed();
	input.rawBody = Buffer.from('{bad-json');
	input.headers['x-oveyon-signature'] = `sha256=${createHmac('sha256', SECRET).update(String(NOW)).update('.').update(input.rawBody).digest('hex')}`;
	assert.equal(validateWebhook(input).status, 400);
});

test('setup rejects arbitrary reflection and contradictory challenge fields', () => {
	for (const body of [{ ...challenge, challenge: '<script>anything</script>' }, { ...challenge, event: 'inbound.received' }, { ...challenge, challenge: 'x'.repeat(64) }, { ...challenge, padding: 'x'.repeat(4096) }]) {
		const result = validateWebhook(signed(body, { mode: 'setup' }));
		assert.ok(result.status >= 400);
		assert.equal(result.event, undefined);
	}
});

test('authentic unselected delivery events are acknowledged without starting a workflow', () => {
	const result = validateWebhook(signed({ event: 'opened' }, { family: 'delivery', events: ['delivered'] }));
	assert.deepEqual(result, { status: 200, response: { received: true, filtered: true } });
});

test('signature uses original whitespace and UTF-8 bytes', () => {
	const rawBody = Buffer.from('{ "event": "delivered", "detail": "Olá ✓" }');
	const input = signed({ event: 'delivered' }, { rawBody, family: 'delivery' });
	input.headers['x-oveyon-signature'] = `sha256=${createHmac('sha256', SECRET).update(String(NOW)).update('.').update(rawBody).digest('hex')}`;
	assert.equal(validateWebhook(input).event.detail, 'Olá ✓');
});

test('webhook node returns a direct challenge response without workflowData or credential access', async () => {
	const input = signed(challenge, { mode: 'setup' });
	input.headers['x-oveyon-timestamp'] = String(Math.floor(Date.now() / 1000));
	const result = {};
	const ctx = {
		getNodeParameter: (name, fallback) => ({ mode: 'inboundSetup' })[name] ?? fallback,
		getRequestObject: () => ({ rawBody: input.rawBody }),
		getHeaderData: () => input.headers,
		getCredentials: () => { throw new Error('Setup must not request credentials'); },
		getResponseObject: () => ({ status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } }),
	};
	const output = await new OveyonTrigger().webhook.call(ctx);
	assert.equal(result.status, 200);
	assert.deepEqual(output, { noWebhookResponse: true });
});

test('webhook credential test describes format validation honestly', async () => {
	const good = await testSigningSecret({ data: { signingSecret: SECRET } });
	assert.equal(good.status, 'OK');
	assert.match(good.message, /only when a correctly signed/);
	assert.equal((await testSigningSecret({ data: { signingSecret: 'invalid' } })).status, 'Error');
});

for (const [mode, body] of [['inboundLive', inbound], ['deliveryLive', { event: 'delivered', messageId: 'synthetic-message' }]]) {
	test(`webhook node derives its event family from ${mode}`, async () => {
		const rawBody = Buffer.from(JSON.stringify(body));
		const timestamp = String(Math.floor(Date.now() / 1000));
		const result = {};
		const ctx = {
			getNodeParameter: (name, fallback) => ({ mode, events: DELIVERY_EVENTS })[name] ?? fallback,
			getRequestObject: () => ({ rawBody }),
			getHeaderData: () => ({ 'content-type': 'application/json', 'x-oveyon-event': body.event, 'x-oveyon-timestamp': timestamp, 'x-oveyon-signature': `sha256=${createHmac('sha256', SECRET).update(timestamp).update('.').update(rawBody).digest('hex')}` }),
			getCredentials: async name => { assert.equal(name, 'oveyonWebhookApi'); return { signingSecret: SECRET }; },
			getResponseObject: () => ({ status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } }),
		};
		const output = await new OveyonTrigger().webhook.call(ctx);
		assert.equal(result.status, 200);
		assert.deepEqual(output.workflowData, [[{ json: body }]]);
	});
}
