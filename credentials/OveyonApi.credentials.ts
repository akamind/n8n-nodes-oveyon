import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
	Icon,
} from 'n8n-workflow';

export class OveyonApi implements ICredentialType {
	name = 'oveyonApi';
	icon: Icon = { light: 'file:icons/oveyon.svg', dark: 'file:icons/oveyon.svg' };
	displayName = 'Oveyon API';
	documentationUrl = 'https://github.com/akamind/n8n-nodes-oveyon#credentials';
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description: 'REST API key from Oveyon. MCP OAuth tokens cannot access this API.',
		},
		{
			displayName:
				'The connection test requires read:messages. A key limited to Send or Reply can be saved and used even if this read test reports insufficient scope.',
			name: 'testNotice',
			type: 'notice',
			default: '',
		},
	];
	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } },
	};
	test: ICredentialTestRequest = {
		request: {
			method: 'GET',
			url: 'https://api.oveyon.com/v1/messages',
			qs: { limit: 1 },
			timeout: 30000,
			json: true,
			disableFollowRedirect: true,
			// This n8n option defines validateStatus as !except.includes(status).
			// Reject every other three-digit HTTP status, including unexpected 2xx.
			ignoreHttpStatusErrors: {
				ignore: true,
				except: Array.from({ length: 900 }, (_, index) => index + 100).filter(
					(status) => status !== 200,
				),
			},
		},
		rules: [
			// n8n treats any 2xx as a successful connection by default. This read
			// endpoint has exactly one successful status: 200.
			...Array.from({ length: 101 }, (_, index) => 199 + index)
				.filter((status) => status !== 200)
				.map((status) => ({
					type: 'responseCode' as const,
					properties: {
						value: status,
						message:
							'Oveyon returned an unexpected status while testing the API key. Expected HTTP 200.',
					},
				})),
			{
				type: 'responseCode',
				properties: {
					value: 401,
					message: 'Authentication failed. Enter a valid Oveyon REST API key.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 403,
					message:
						'Reading messages was denied. The connection test requires read:messages. If Oveyon reports insufficient_scope, this key can still use Send or Reply with their own scopes; otherwise check key status, account status, and IP restrictions.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 429,
					message: 'The connection test was rate limited. Wait and try again.',
				},
			},
			{
				type: 'responseCode',
				properties: {
					value: 500,
					message: 'Oveyon is temporarily unavailable. Try the connection test again later.',
				},
			},
		],
	};
}
