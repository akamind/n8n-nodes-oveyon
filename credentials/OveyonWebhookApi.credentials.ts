import type { ICredentialType, INodeProperties, Icon } from 'n8n-workflow';

export class OveyonWebhookApi implements ICredentialType {
	name = 'oveyonWebhookApi';
	icon: Icon = { light: 'file:icons/oveyon.svg', dark: 'file:icons/oveyon.svg' };
	displayName = 'Oveyon Webhook API';
	documentationUrl = 'https://github.com/akamind/n8n-nodes-oveyon#webhook-setup';
	properties: INodeProperties[] = [
		{
			displayName:
				'The credential test checks the secret format only. Verify the endpoint by receiving a correctly signed Oveyon event.',
			name: 'testNotice',
			type: 'notice',
			default: '',
		},
		{
			displayName: 'Signing Secret',
			name: 'signingSecret',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
			description:
				'The 64-character hexadecimal secret shown once by Oveyon for this webhook endpoint. This is not an API key.',
		},
	];
}
