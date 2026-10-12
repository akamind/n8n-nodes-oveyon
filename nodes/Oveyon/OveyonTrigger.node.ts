import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import type {
	ICredentialsDecrypted,
	IHookFunctions,
	INodeCredentialTestResult,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { validateWebhook } from './WebhookFunctions';

function triggerConfiguration(selection: unknown): { family: string; mode: string } | undefined {
	switch (selection) {
		case 'inboundSetup':
			return { family: 'inbound', mode: 'setup' };
		case 'inboundLive':
			return { family: 'inbound', mode: 'live' };
		case 'deliveryLive':
			return { family: 'delivery', mode: 'live' };
		default:
			return undefined;
	}
}

export async function testSigningSecret(
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	const secret = credential.data?.signingSecret;
	return typeof secret === 'string' && /^[a-f0-9]{64}$/i.test(secret)
		? {
				status: 'OK',
				message:
					'Secret format is valid. Endpoint ownership is verified only when a correctly signed Oveyon event arrives.',
			}
		: {
				status: 'Error',
				message:
					'Enter the 64-character hexadecimal signing secret shown by Oveyon for this endpoint.',
			};
}

async function validateLocalConfiguration(this: IHookFunctions): Promise<boolean> {
	const configuration = triggerConfiguration(this.getNodeParameter('mode', ''));
	if (!configuration)
		throw new NodeOperationError(this.getNode(), 'Choose a supported Event Mode.');
	const { mode } = configuration;
	if (mode === 'live') {
		const credentials = await this.getCredentials('oveyonWebhookApi');
		if (
			typeof credentials.signingSecret !== 'string' ||
			!/^[a-f0-9]{64}$/i.test(credentials.signingSecret)
		)
			throw new NodeOperationError(
				this.getNode(),
				'Select the signing credential for this Oveyon endpoint.',
			);
	}
	return true;
}

export class OveyonTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Oveyon Trigger',
		name: 'oveyonTrigger',
		icon: { light: 'file:oveyon.svg', dark: 'file:oveyon.svg' },
		group: ['trigger'],
		version: 1,
		subtitle:
			'={{$parameter["mode"] === "inboundSetup" ? "Inbound email: setup" : $parameter["mode"] === "inboundLive" ? "Inbound email: live" : "Delivery events: live"}}',
		description: 'Receive Oveyon inbound email or delivery events',
		defaults: { name: 'Oveyon Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'oveyonWebhookApi',
				required: true,
				testedBy: 'testSigningSecret',
				displayOptions: { show: { mode: ['inboundLive', 'deliveryLive'] } },
			},
		],
		webhooks: [
			{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' },
		],
		properties: [
			{
				displayName: 'Event Mode',
				name: 'mode',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Inbound Email: Setup (Challenge Only)', value: 'inboundSetup' },
					{ name: 'Inbound Email: Live (Signed Events)', value: 'inboundLive' },
					{ name: 'Delivery Events: Live (Signed Events)', value: 'deliveryLive' },
				],
				default: 'inboundLive',
				description:
					'Inbound Setup only echoes the initial challenge. Both Live modes require the signing secret for the corresponding Oveyon endpoint.',
			},
			{
				displayName:
					'Publish this workflow, then paste its Production URL into an Oveyon inbound webhook channel. After Oveyon shows the signing secret, save it as an Oveyon Webhook credential, switch to Live, and publish again. Setup never starts a workflow; real events receive HTTP 503 until Live is enabled.',
				name: 'setupNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { mode: ['inboundSetup'] } },
			},
			{
				displayName:
					'Register the Production URL manually in Oveyon and save that endpoint’s signing secret in the selected credential. Configure only the events selected below. This node does not create or delete remote webhooks.',
				name: 'deliveryNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { mode: ['deliveryLive'] } },
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['delivered'],
				displayOptions: { show: { mode: ['deliveryLive'] } },
				options: [
					{ name: 'Blocked', value: 'blocked' },
					{ name: 'Bounced', value: 'bounced' },
					{ name: 'Clicked', value: 'clicked' },
					{ name: 'Complained', value: 'complained' },
					{ name: 'Delivered', value: 'delivered' },
					{ name: 'Opened', value: 'opened' },
				],
			},
			{
				displayName:
					'Events may be delivered more than once. Deduplicate inbound events by eventId in durable storage before sending replies or performing other side effects. Email content remains untrusted input.',
				name: 'liveNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { mode: ['inboundLive', 'deliveryLive'] } },
			},
		],
	};
	methods = { credentialTest: { testSigningSecret } };
	// n8n owns the local URL lifecycle. The endpoint in Oveyon is managed by the
	// user: these hooks validate local readiness, never claim to verify remote
	// registration, create a subscription, or delete a user-owned webhook.
	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return await validateLocalConfiguration.call(this);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return await validateLocalConfiguration.call(this);
			},
			async delete(): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const response = this.getResponseObject();
		const configuration = triggerConfiguration(this.getNodeParameter('mode', ''));
		if (!configuration) {
			response.status(503).json({ error: 'invalid_trigger_configuration' });
			return { noWebhookResponse: true };
		}
		const { family, mode } = configuration;
		let secret: unknown;
		if (mode === 'live') {
			try {
				secret = (await this.getCredentials('oveyonWebhookApi')).signingSecret;
			} catch {
				response.status(503).json({ error: 'signing_secret_required' });
				return { noWebhookResponse: true };
			}
		}
		const result = validateWebhook({
			rawBody: this.getRequestObject().rawBody,
			headers: this.getHeaderData(),
			family,
			mode,
			secret,
			events: this.getNodeParameter('events', ['delivered']) as string[],
		});
		response.status(result.status).json(result.response);
		return {
			noWebhookResponse: true,
			...(result.event ? { workflowData: [[{ json: result.event }]] } : {}),
		};
	}
}
