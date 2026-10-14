import { NodeOperationError, sleep } from 'n8n-workflow';
import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

export const API_BASE = 'https://api.oveyon.com';
// Upper bound of the user-set Limit. Return All has no item ceiling: it follows
// next_cursor to the end, protected by the repeated-cursor and empty-page guards.
export const MAX_ITEMS = 10000;
// A long Return All can outrun the per-minute read limit of the API key. Get Many
// waits as Oveyon asks (capped) and repeats the same page, a few times in a row.
const RATE_LIMIT_RETRIES = 3;
const MAX_RETRY_WAIT_SECONDS = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_PATH =
	/^\/v1\/(?:send|messages(?:\/[0-9a-f-]{36})?|inbound(?:\/[0-9a-f-]{36}(?:\/(?:content|reply))?)?)$/i;

export function isObject(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ERROR_HELP: Record<string, string> = {
	unauthorized: 'Check the API key in your Oveyon API credential.',
	insufficient_scope: 'Enable the scope required for this operation in Oveyon.',
	key_disabled: 'Enable this API key in Oveyon or select an enabled credential.',
	account_suspended: 'Contact Oveyon support about the account status.',
	account_unknown: 'Check the account associated with this API key.',
	ip_not_allowed: 'Allow the n8n outbound IP in the API key IP rules.',
	ip_rules_unavailable: 'IP policy validation is temporarily unavailable.',
	sending_disabled: 'Enable sending for this API key in Oveyon.',
	not_found: 'Check the message ID and whether the credential can access it.',
	rate_limited: 'Wait before retrying. Reuse the same idempotency key for writes.',
	too_many_auth_failures: 'Wait before retrying and check the API key.',
	quota_exceeded: 'Review your account quota before retrying.',
	warmup_cap_reached: 'Wait for the sending warm-up allowance to recover.',
	queue_full: 'The sending queue is temporarily full.',
	bad_cursor:
		'The pagination cursor expired or is invalid. Run the node again, narrowing the date filters if needed.',
	policy_refused: 'An Oveyon sending policy refused this operation.',
	message_quarantined: 'A person must review the quarantined message in Oveyon before replying.',
	recipient_quarantined: 'The selected mailbox copy is held for review in Oveyon.',
	message_blocked: 'Oveyon blocked this message; it cannot be replied to.',
	copy_expired: 'The retained mailbox copy has expired.',
	auto_submitted: 'Automated or bulk email cannot be replied to by this operation.',
	reply_limit: 'The reply limit for this message has been reached.',
	thread_reply_limit: 'The conversation reply limit has been reached.',
	domain_not_verified: 'Verify the sender domain in Oveyon.',
	domain_not_allowed_for_credential: 'Allow the sender domain for this API key.',
	recipient_suppressed: 'The recipient is suppressed in Oveyon.',
	from_not_recipient: 'Choose a mailbox that received this message.',
	body_too_long: 'Shorten the reply to at most 20,000 characters.',
	no_reply_address: 'This message has no address that can receive a reply.',
	injection_failed: 'The message could not be queued. Retry with the same idempotency key.',
	record_failed: 'The reply could not be recorded. Retry with the same idempotency key.',
};

function retryAfter(headers: unknown): number | undefined {
	const retry = isObject(headers) ? headers['retry-after'] : undefined;
	return (typeof retry === 'string' || typeof retry === 'number') && /^\d{1,5}$/.test(String(retry))
		? Number(retry)
		: undefined;
}

export function safeApiError(status: number, body: unknown, headers: unknown = {}): string {
	const code = isObject(body) && typeof body.error === 'string' ? body.error : '';
	const help = Object.hasOwn(ERROR_HELP, code)
		? `${code}: ${ERROR_HELP[code]}`
		: status === 401
			? 'Authentication failed. Check your REST API key.'
			: status === 403
				? 'Access denied. Check credential scopes, status, and IP restrictions.'
				: status === 429
					? 'Rate or quota limit reached. Review your Oveyon account before retrying.'
					: status >= 300 && status < 400
						? 'Unexpected redirect refused. Contact Oveyon support.'
						: status >= 500
							? 'Oveyon is temporarily unavailable. Reuse the same idempotency key for writes.'
							: 'The API refused the request. Check the operation parameters in the Oveyon documentation.';
	const retry = retryAfter(headers);
	const wait = retry !== undefined ? ` Retry after at least ${retry} seconds.` : '';
	return `Oveyon API (HTTP ${Number.isInteger(status) ? status : 0}): ${help}${wait}`;
}

export function messageId(value: unknown): string {
	if (typeof value !== 'string' || !UUID.test(value.trim())) {
		throw new Error('Message ID must be an Oveyon UUID.');
	}
	return value.trim();
}

interface ApiResponse {
	statusCode: number;
	body: unknown;
	headers: unknown;
}

async function sendRequest(
	this: IExecuteFunctions,
	method: 'GET' | 'POST',
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<ApiResponse> {
	if (!API_PATH.test(path))
		throw new NodeOperationError(this.getNode(), 'Invalid API resource path.');
	let response: unknown;
	try {
		response = await this.helpers.httpRequestWithAuthentication.call(this, 'oveyonApi', {
			method,
			url: `${API_BASE}${path}`,
			headers: { Accept: 'application/json' },
			body,
			qs,
			json: true,
			timeout: 30000,
			disableFollowRedirect: true,
			returnFullResponse: true,
			ignoreHttpStatusErrors: true,
		});
	} catch {
		// Transport errors can embed the Authorization header or a request body.
		throw new NodeOperationError(
			this.getNode(),
			'Could not reach the Oveyon API. Check your connection and credential. The result of a write may be unknown; reuse the same idempotency key if you retry.',
		);
	}
	if (!isObject(response) || typeof response.statusCode !== 'number') {
		throw new NodeOperationError(this.getNode(), 'Oveyon returned an invalid HTTP response.');
	}
	return { statusCode: response.statusCode, body: response.body, headers: response.headers };
}

function apiResult(this: IExecuteFunctions, response: ApiResponse): IDataObject {
	if (response.statusCode < 200 || response.statusCode >= 300) {
		throw new NodeOperationError(
			this.getNode(),
			safeApiError(response.statusCode, response.body, response.headers),
		);
	}
	if (!isObject(response.body))
		throw new NodeOperationError(this.getNode(), 'Oveyon returned an invalid JSON response.');
	return response.body;
}

export async function apiRequest(
	this: IExecuteFunctions,
	method: 'GET' | 'POST',
	path: string,
	body?: IDataObject,
	qs?: IDataObject,
): Promise<IDataObject> {
	return apiResult.call(this, await sendRequest.call(this, method, path, body, qs));
}

// Reads only: a rate-limited page is requested again after the wait Oveyon asks for.
async function readPage(
	this: IExecuteFunctions,
	path: '/v1/messages' | '/v1/inbound',
	query: IDataObject,
): Promise<IDataObject> {
	for (let attempt = 0; ; attempt++) {
		const response = await sendRequest.call(this, 'GET', path, undefined, query);
		const code =
			isObject(response.body) && typeof response.body.error === 'string' ? response.body.error : '';
		if (response.statusCode !== 429 || code !== 'rate_limited' || attempt >= RATE_LIMIT_RETRIES)
			return apiResult.call(this, response);
		// Stopping the execution also ends the wait (older n8n ignores the signal).
		await sleep(
			Math.min(retryAfter(response.headers) ?? MAX_RETRY_WAIT_SECONDS, MAX_RETRY_WAIT_SECONDS) *
				1000,
			this.getExecutionCancelSignal?.(),
		);
	}
}

export async function getMany(
	this: IExecuteFunctions,
	path: '/v1/messages' | '/v1/inbound',
	filters: IDataObject,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	if (!returnAll && (!Number.isInteger(limit) || limit < 1 || limit > MAX_ITEMS))
		throw new Error(`Limit must be between 1 and ${MAX_ITEMS}.`);
	const items: IDataObject[] = [];
	const seen = new Set<string>();
	// The cursor is a transport detail: it only ever comes from the previous page.
	let cursor: unknown;
	for (;;) {
		const pageSize = returnAll ? 100 : Math.min(100, limit - items.length);
		if (cursor !== undefined) {
			if (typeof cursor !== 'string' || cursor.length > 2048 || seen.has(cursor))
				throw new Error('Invalid or repeated pagination cursor. Narrow the filters and try again.');
			seen.add(cursor);
		}
		const page = await readPage.call(this, path, {
			...filters,
			limit: pageSize,
			...(cursor !== undefined ? { cursor: cursor as string } : {}),
		});
		if (!Array.isArray(page.data) || !page.data.every(isObject))
			throw new Error('Oveyon returned an invalid list response.');
		if (page.data.length > pageSize) throw new Error('Oveyon returned more items than requested.');
		items.push(...page.data);
		const next = page.next_cursor;
		if (next === null || next === undefined || next === '') return items;
		if (page.data.length === 0)
			throw new Error(
				'Oveyon returned an empty page with a cursor. Narrow the filters and try again.',
			);
		if (!returnAll && items.length >= limit) return items;
		cursor = next;
	}
}

export function simplify(value: IDataObject, resource: string): IDataObject {
	const fields =
		resource === 'email'
			? ['id', 'from', 'to', 'subject', 'status', 'acceptedAt', 'deliveredAt']
			: [
					'id',
					'receivedAt',
					'from',
					'fromHeader',
					'subject',
					'recipients',
					'outcome',
					'authentication',
					'agentSafety',
					'quarantine',
				];
	return Object.fromEntries(
		fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
	);
}
