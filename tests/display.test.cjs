'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeHelpers, Workflow } = require('n8n-workflow');
const { OveyonTrigger } = require('../dist/nodes/Oveyon/OveyonTrigger.node.js');

const trigger = new OveyonTrigger();
const description = trigger.description;
const node = { name: 'Oveyon Trigger', type: '@oveyon/n8n-nodes-oveyon.oveyonTrigger', typeVersion: 1, position: [0, 0], parameters: {} };
const visible = (values, property) => NodeHelpers.displayParameter(values, property, node, description);

for (const [mode, signed, delivery] of [
	['inboundSetup', false, false],
	['inboundLive', true, false],
	['deliveryLive', true, true],
]) {
	test(`n8n display helper: ${mode} exposes the correct credentials and notices`, () => {
		const values = NodeHelpers.getNodeParameters(description.properties, { mode }, true, false, node, description);
		assert.equal(values.mode, mode);
		assert.equal(description.credentials.length, 1, 'Only one descriptor may own the shared credential');
		assert.equal(visible(values, description.credentials[0]), signed);
		for (const [name, expected] of [['liveNotice', signed], ['events', delivery]]) {
			assert.equal(visible(values, description.properties.find(property => property.name === name)), expected, name);
		}
		assert.deepEqual([...NodeHelpers.getActiveCredentialTypes({ ...node, parameters: values }, description)], signed ? ['oveyonWebhookApi'] : []);
	});
}

test('setup and delivery guidance live in the README; only the at-least-once notice stays in the trigger', () => {
	assert.deepEqual(description.properties.filter(property => property.type === 'notice').map(property => property.name), ['liveNotice']);
	assert.match(description.properties.find(property => property.name === 'liveNotice').displayName, /more than once/);
});

test('default and repeated mode transitions do not retain a hidden family selector', () => {
	let values = NodeHelpers.getNodeParameters(description.properties, {}, true, false, node, description);
	assert.equal(values.mode, 'inboundLive');
	for (const mode of ['deliveryLive', 'inboundSetup', 'inboundLive', 'deliveryLive', 'inboundLive', 'inboundSetup']) {
		values = NodeHelpers.getNodeParameters(description.properties, { ...values, mode }, true, false, node, description);
		assert.equal(values.mode, mode);
		assert.equal(Object.hasOwn(values, 'family'), false);
		assert.equal(visible(values, description.credentials[0]), mode !== 'inboundSetup');
		assert.equal(visible(values, description.properties.find(property => property.name === 'liveNotice')), mode !== 'inboundSetup');
	}
});

for (const [label, parameters] of [
	['missing mode', {}],
	['legacy inbound without mode', { family: 'inbound' }],
	['legacy delivery without mode', { family: 'delivery' }],
	['legacy setup mode', { mode: 'setup' }],
	['legacy live mode', { mode: 'live' }],
	['unknown mode', { mode: 'unknown' }],
	['empty mode', { mode: '' }],
]) {
	test(`real Workflow normalization never opens unsigned setup for ${label}`, async () => {
		const workflow = new Workflow({
			nodes: [{ ...node, parameters: { ...parameters } }],
			connections: {},
			active: false,
			nodeTypes: { getByNameAndVersion: () => trigger },
		});
		const normalizedNode = workflow.getNode(node.name);
		const values = normalizedNode.parameters;
		assert.notEqual(values.mode, 'inboundSetup');
		if (!Object.hasOwn(parameters, 'mode')) {
			assert.equal(values.mode, 'inboundLive');
			assert.deepEqual([...NodeHelpers.getActiveCredentialTypes(normalizedNode, description)], ['oveyonWebhookApi']);
		}
		const response = {};
		const context = {
			getNodeParameter: (name, fallback) => values[name] ?? fallback,
			getNode: () => normalizedNode,
			getCredentials: async () => ({ signingSecret: '' }),
			getRequestObject: () => ({ rawBody: Buffer.from(JSON.stringify({ type: 'url_verification', challenge: 'b'.repeat(64), url: 'https://example.invalid/webhook', sentAt: new Date().toISOString() })) }),
			getHeaderData: () => ({ 'content-type': 'application/json', 'x-oveyon-event': 'url_verification', 'x-oveyon-timestamp': String(Math.floor(Date.now() / 1000)) }),
			getResponseObject: () => ({ status(code) { response.status = code; return this; }, json(body) { response.body = body; return this; } }),
		};
		await assert.rejects(trigger.webhookMethods.default.checkExists.call(context), /signing credential|supported Event Mode/);
		// Even a valid saved credential must not turn an unsigned request into a challenge echo.
		context.getCredentials = async () => ({ signingSecret: 'a'.repeat(64) });
		assert.deepEqual(await trigger.webhook.call(context), { noWebhookResponse: true });
		assert.equal(response.status, values.mode === 'inboundLive' ? 401 : 503);
		assert.equal(Object.hasOwn(response.body, 'challenge'), false);
	});
}

test('real Workflow normalization preserves only explicitly selected unsigned setup', async () => {
	const workflow = new Workflow({
		nodes: [{ ...node, parameters: { mode: 'inboundSetup' } }],
		connections: {},
		active: false,
		nodeTypes: { getByNameAndVersion: () => trigger },
	});
	const values = workflow.getNode(node.name).parameters;
	assert.equal(values.mode, 'inboundSetup');
	const response = {};
	const challenge = 'b'.repeat(64);
	const context = {
		getNodeParameter: (name, fallback) => values[name] ?? fallback,
		getCredentials: async () => { throw new Error('Explicit setup must not access a credential'); },
		getRequestObject: () => ({ rawBody: Buffer.from(JSON.stringify({ type: 'url_verification', challenge, url: 'https://example.invalid/webhook', sentAt: new Date().toISOString() })) }),
		getHeaderData: () => ({ 'content-type': 'application/json', 'x-oveyon-event': 'url_verification', 'x-oveyon-timestamp': String(Math.floor(Date.now() / 1000)) }),
		getResponseObject: () => ({ status(code) { response.status = code; return this; }, json(body) { response.body = body; return this; } }),
	};
	assert.deepEqual(await trigger.webhook.call(context), { noWebhookResponse: true });
	assert.equal(response.status, 200);
	assert.deepEqual(response.body, { challenge });
});

for (const mode of ['inboundSetup', 'inboundLive', 'deliveryLive']) {
	test(`local activation ${mode} can obtain only the credential visible to n8n`, async () => {
		let credentialReads = 0;
		const values = NodeHelpers.getNodeParameters(description.properties, { mode }, true, false, node, description);
		const context = {
			getNodeParameter: (name, fallback) => values[name] ?? fallback,
			getNode: () => ({ ...node, parameters: values }),
			getCredentials: async name => {
				// n8n's runtime uses the first matching descriptor and applies this helper.
				const credential = description.credentials.find(item => item.name === name);
				assert.equal(visible(values, credential), true, 'n8n would reject a hidden credential');
				credentialReads++;
				return { signingSecret: 'a'.repeat(64) };
			},
		};
		assert.equal(await trigger.webhookMethods.default.checkExists.call(context), true);
		assert.equal(await trigger.webhookMethods.default.create.call(context), true);
		assert.equal(credentialReads, mode === 'inboundSetup' ? 0 : 2);
	});
}

test('both live modes block activation with an invalid signing secret', async () => {
	for (const mode of ['inboundLive', 'deliveryLive']) {
		await assert.rejects(trigger.webhookMethods.default.checkExists.call({
			getNodeParameter: (name, fallback) => name === 'mode' ? mode : fallback,
			getNode: () => node,
			getCredentials: async () => ({ signingSecret: '' }),
		}), /signing credential/);
	}
});

for (const mode of [undefined, 'setup', 'unknown']) {
	test(`missing or unsupported mode ${String(mode)} never enables setup implicitly`, async () => {
		const response = {};
		const context = {
			getNodeParameter: (name, fallback) => name === 'mode' ? mode ?? fallback : fallback,
			getNode: () => node,
			getCredentials: async () => { throw new Error('Invalid configuration must not decrypt a credential'); },
			getResponseObject: () => ({ status(code) { response.status = code; return this; }, json(body) { response.body = body; return this; } }),
		};
		await assert.rejects(trigger.webhookMethods.default.checkExists.call(context), /supported Event Mode/);
		assert.deepEqual(await trigger.webhook.call(context), { noWebhookResponse: true });
		assert.equal(response.status, 503);
		assert.deepEqual(response.body, { error: 'invalid_trigger_configuration' });
	});
}

test('credential notices make connection-test limitations visible independently of n8n success messages', () => {
	const { OveyonApi } = require('../dist/credentials/OveyonApi.credentials.js');
	const { OveyonWebhookApi } = require('../dist/credentials/OveyonWebhookApi.credentials.js');
	const apiNotice = new OveyonApi().properties.find(property => property.name === 'testNotice');
	const webhookNotice = new OveyonWebhookApi().properties.find(property => property.name === 'testNotice');
	assert.equal(apiNotice.type, 'notice');
	assert.match(apiNotice.displayName, /read:messages/);
	assert.match(apiNotice.displayName, /saved and used/);
	assert.equal(webhookNotice.type, 'notice');
	assert.match(webhookNotice.displayName, /secret format only/);
	assert.equal(apiNotice.displayOptions, undefined);
	assert.equal(webhookNotice.displayOptions, undefined);
});
