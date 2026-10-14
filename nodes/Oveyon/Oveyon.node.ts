import { NodeConnectionTypes, NodeOperationError, UserError } from 'n8n-workflow';
import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { properties } from './Description';
import { apiRequest, getMany, messageId, simplify } from './GenericFunctions';

function text(value: unknown, label: string, max = Infinity, singleLine = false): string {
	if (typeof value !== 'string' || value.length > max || (singleLine && /[\r\n\0]/.test(value)))
		throw new UserError(`${label} is invalid or exceeds its allowed length.`);
	return value;
}

function addresses(value: unknown): string[] {
	const result = text(value, 'Recipients', 40000, true)
		.split(',')
		.map((address) => address.trim());
	if (
		!result.length ||
		result.some((address) => !/^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(address))
	)
		throw new UserError(
			'Enter valid recipient email addresses separated by commas, without display names.',
		);
	return result;
}

function applyOptions(body: IDataObject, options: IDataObject): void {
	if (options.idempotencyKey !== undefined && options.idempotencyKey !== '') {
		if (
			typeof options.idempotencyKey !== 'string' ||
			!/^[\x21-\x7e]{1,255}$/.test(options.idempotencyKey)
		)
			throw new UserError(
				'Idempotency Key must contain 1 to 255 printable ASCII characters without spaces.',
			);
		body.idempotencyKey = options.idempotencyKey;
	}
	if (options.hold !== undefined) {
		if (typeof options.hold !== 'boolean')
			throw new UserError('Hold for Approval must be a boolean.');
		body.hold = options.hold;
	}
	if (options.hold === true) {
		if (options.holdTtl !== undefined) {
			if (
				typeof options.holdTtl !== 'number' ||
				!Number.isInteger(options.holdTtl) ||
				options.holdTtl < 300 ||
				options.holdTtl > 604800
			)
				throw new UserError('Hold TTL must be 300 to 604800 seconds.');
			body.holdTtl = options.holdTtl;
		}
		if (options.holdNote !== undefined) body.holdNote = text(options.holdNote, 'Hold Note', 500);
	}
}

export class Oveyon implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oveyon',
		name: 'oveyon',
		icon: { light: 'file:oveyon.svg', dark: 'file:oveyon.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send, read, and reply to email with Oveyon',
		defaults: { name: 'Oveyon' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'oveyonApi', required: true }],
		usableAsTool: true,
		properties,
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const output: INodeExecutionData[] = [];
		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let result: IDataObject[];
				if (operation === 'send' && resource === 'email') {
					const from = text(this.getNodeParameter('from', i), 'From', 500, true).trim();
					if (!from) throw new UserError('From is required.');
					const plain = text(this.getNodeParameter('text', i, ''), 'Text');
					const html = text(this.getNodeParameter('html', i, ''), 'HTML');
					if (!plain.trim() && !html.trim()) throw new UserError('Provide a Text or HTML body.');
					const body: IDataObject = {
						from,
						to: addresses(this.getNodeParameter('to', i)),
						subject: text(this.getNodeParameter('subject', i, ''), 'Subject', 500, true),
						...(plain ? { text: plain } : {}),
						...(html ? { html } : {}),
					};
					const options = this.getNodeParameter('sendOptions', i, {}) as IDataObject;
					applyOptions(body, options);
					for (const field of ['cc', 'bcc'])
						if (options[field]) body[field] = addresses(options[field]);
					if (options.sandbox !== undefined) {
						if (typeof options.sandbox !== 'boolean')
							throw new UserError('Sandbox must be a boolean.');
						body.sandbox = options.sandbox;
					}
					result = [await apiRequest.call(this, 'POST', '/v1/send', body)];
				} else if (operation === 'reply' && resource === 'inbound') {
					const id = messageId(this.getNodeParameter('messageId', i));
					const plain = text(this.getNodeParameter('text', i, ''), 'Text', 20000);
					if (!plain.trim()) throw new UserError('A plain-text reply body is required.');
					const body: IDataObject = { text: plain };
					const options = this.getNodeParameter('replyOptions', i, {}) as IDataObject;
					applyOptions(body, options);
					if (options.from) body.from = text(options.from, 'From Mailbox', 320, true);
					if (options.subject) body.subject = text(options.subject, 'Subject', 500, true);
					result = [await apiRequest.call(this, 'POST', `/v1/inbound/${id}/reply`, body)];
				} else if ((resource === 'email' || resource === 'inbound') && operation === 'getMany') {
					const filters: IDataObject = {};
					const selected = this.getNodeParameter('filters', i, {}) as IDataObject;
					for (const field of ['from', 'to', 'recipient', 'sender'])
						if (selected[field]) filters[field] = text(selected[field], 'Filter', 2048, true);
					const returnAll = this.getNodeParameter('returnAll', i, false);
					if (typeof returnAll !== 'boolean') throw new UserError('Return All must be a boolean.');
					result = await getMany.call(
						this,
						resource === 'email' ? '/v1/messages' : '/v1/inbound',
						filters,
						returnAll,
						this.getNodeParameter('limit', i, 50) as number,
					);
				} else if (
					(resource === 'email' || resource === 'inbound') &&
					(operation === 'get' || (operation === 'getContent' && resource === 'inbound'))
				) {
					const id = messageId(this.getNodeParameter('messageId', i));
					const path =
						resource === 'email'
							? `/v1/messages/${id}`
							: `/v1/inbound/${id}${operation === 'getContent' ? '/content' : ''}`;
					result = [await apiRequest.call(this, 'GET', path)];
				} else throw new UserError('Unsupported Oveyon resource or operation.');
				const useSimplify =
					['get', 'getMany'].includes(operation) && this.getNodeParameter('simplify', i, true);
				for (const data of result)
					output.push({
						json: useSimplify ? simplify(data, resource) : data,
						pairedItem: { item: i },
					});
			} catch (error) {
				const failure =
					error instanceof NodeOperationError
						? error
						: new NodeOperationError(
								this.getNode(),
								error instanceof Error ? error.message : 'Oveyon operation failed.',
								{ itemIndex: i },
							);
				if (!this.continueOnFail()) throw failure;
				output.push({ json: { error: failure.message }, pairedItem: { item: i } });
			}
		}
		return [output];
	}
}
