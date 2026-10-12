import { createHmac, timingSafeEqual } from 'crypto';
import type { IDataObject } from 'n8n-workflow';
import { isObject } from './GenericFunctions';

export const DELIVERY_EVENTS = [
	'delivered',
	'bounced',
	'opened',
	'clicked',
	'complained',
	'blocked',
];
export const MAX_WEBHOOK_BYTES = 1024 * 1024;
const CHALLENGE_LIMIT = 4096;
const MAX_AGE_SECONDS = 300;

export type WebhookResult = { status: number; response: IDataObject; event?: IDataObject };

export function validateWebhook(input: {
	rawBody: unknown;
	headers: Record<string, unknown>;
	family: string;
	mode: string;
	secret?: unknown;
	events: string[];
	now?: number;
}): WebhookResult {
	const reject = (status: number, error: string): WebhookResult => ({
		status,
		response: { error },
	});
	if (
		!['inbound', 'delivery'].includes(input.family) ||
		!['setup', 'live'].includes(input.mode) ||
		(input.family === 'delivery' && input.mode !== 'live')
	)
		return reject(503, 'invalid_trigger_configuration');
	if (!Buffer.isBuffer(input.rawBody)) return reject(400, 'raw_body_required');
	const raw = input.rawBody;
	if (raw.length > (input.mode === 'setup' ? CHALLENGE_LIMIT : MAX_WEBHOOK_BYTES))
		return reject(413, 'payload_too_large');
	const contentType = input.headers['content-type'];
	if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/i.test(contentType))
		return reject(415, 'application_json_required');
	const timestamp = input.headers['x-oveyon-timestamp'];
	if (
		typeof timestamp !== 'string' ||
		!/^\d{10}$/.test(timestamp) ||
		Math.abs((input.now ?? Math.floor(Date.now() / 1000)) - Number(timestamp)) > MAX_AGE_SECONDS
	)
		return reject(401, 'invalid_timestamp');
	if (input.mode === 'live') {
		if (typeof input.secret !== 'string' || !/^[a-f0-9]{64}$/i.test(input.secret))
			return reject(503, 'signing_secret_required');
		const signature = input.headers['x-oveyon-signature'];
		if (typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature))
			return reject(401, 'invalid_signature');
		const expected = createHmac('sha256', input.secret)
			.update(timestamp)
			.update('.')
			.update(raw)
			.digest();
		const received = Buffer.from(signature.slice(7), 'hex');
		if (received.length !== expected.length || !timingSafeEqual(received, expected))
			return reject(401, 'invalid_signature');
	}
	let body: unknown;
	try {
		body = JSON.parse(raw.toString('utf8'));
	} catch {
		return reject(400, 'invalid_json');
	}
	if (!isObject(body)) return reject(400, 'invalid_payload');
	const event = input.headers['x-oveyon-event'];
	if (body.type === 'url_verification' && event === 'url_verification') {
		if (
			input.family !== 'inbound' ||
			raw.length > CHALLENGE_LIMIT ||
			body.event !== undefined ||
			typeof body.challenge !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(body.challenge)
		)
			return reject(400, 'invalid_challenge');
		return { status: 200, response: { challenge: body.challenge } };
	}
	if (input.mode === 'setup') return reject(503, 'setup_mode_no_events');
	if (typeof event !== 'string' || body.event !== event || body.type !== undefined)
		return reject(400, 'event_mismatch');
	if (input.family === 'inbound') {
		if (event !== 'inbound.received') return reject(400, 'unexpected_event_family');
		if (
			typeof body.eventId !== 'string' ||
			!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(body.eventId) ||
			!isObject(body.message)
		)
			return reject(400, 'invalid_inbound_payload');
	} else {
		if (!DELIVERY_EVENTS.includes(event)) return reject(400, 'unexpected_event_family');
		if (!input.events.length || input.events.some((item) => !DELIVERY_EVENTS.includes(item)))
			return reject(503, 'invalid_event_selection');
		if (!input.events.includes(event))
			return { status: 200, response: { received: true, filtered: true } };
	}
	return { status: 200, response: { received: true }, event: body };
}
