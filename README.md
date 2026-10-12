# @oveyon/n8n-nodes-oveyon

Connect [Oveyon](https://oveyon.com) email to n8n. This package provides an **Oveyon** action node and an **Oveyon Trigger** for received email and delivery events.

MIT, maintained by Akamind Inc. This package is a release candidate; npm publication and n8n community verification are separate steps and are not claimed here.

## Requirements and installation

- An Oveyon account with a verified sender domain for sending, or an inbound mailbox for receiving.
- n8n with community nodes enabled. The development target is **n8n 2.42.6 on Node.js 24**. Earlier versions are not claimed as tested. The `n8n-workflow` peer uses `*` as required by n8n's verification rules; this does not promise compatibility with every n8n version.
- A public HTTPS n8n webhook URL for events. Keep the n8n clock synchronized.

After publication, self-hosted owners can install `@oveyon/n8n-nodes-oveyon` from **Settings → Community nodes**, following [n8n's installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). Discovery in n8n Cloud requires verification by n8n.

For local development, build the source and install the resulting npm tarball in an isolated n8n environment. Do not replace a production n8n installation to test the package.

## Credentials

**Oveyon API** stores an Oveyon REST API key in n8n's encrypted credentials. Calls go only to `https://api.oveyon.com`, using `Authorization: Bearer …`. Redirects are refused; TLS certificate verification stays enabled; requests time out after 30 seconds. MCP OAuth tokens cannot authenticate the REST API.

| Operation | Scope |
| --- | --- |
| Email → Send | `send` |
| Email → Get / Get Many | `read:messages` |
| Inbound Email → Get / Get Many / Get Content | `read:inbound` |
| Inbound Email → Reply | `reply:inbound` |

The connection test reads at most one sent-message record and never sends an email. A green test requires `read:messages`. A send-only or reply-only key can return `403 insufficient_scope` in this test and still be saved and used for its permitted operations. The 403 explanation also asks you to check key/account status and IP restrictions because not every 403 means a missing scope. If you want the test to pass, add `read:messages`; execution does not require it for sending or replying.

**Oveyon Webhook API** stores the endpoint's 64-character hexadecimal signing secret. It is separate from the API key. Its credential test validates the format locally; only an authentic signed event proves that the secret matches the endpoint. Use a separate credential for each inbound or delivery endpoint. Never paste secrets into node parameters, workflow JSON, execution data, or support messages.

## Operations

| Resource | Operation | Result |
| --- | --- | --- |
| Email | Send | Send receipt, including `accepted`, `sandbox`, `held`, or `duplicate` status |
| Email | Get | One sent message |
| Email | Get Many | One n8n output item per sent message |
| Inbound Email | Get | Received-message metadata, recipients, and security context |
| Inbound Email | Get Many | One n8n output item per received message |
| Inbound Email | Get Content | Parsed text, HTML, reply text, and truncation metadata |
| Inbound Email | Reply | Reply receipt; sender and recipient are derived by Oveyon |

Send accepts a sender, comma-separated recipient email addresses without display names, subject, text and/or HTML, CC/BCC, sandbox, idempotency, and human-approval hold options. Binary attachments, templates, domain administration, and quarantine release are outside this version.

Reply requires plain text, at most 20,000 characters. An optional From Mailbox must have received the original message. Reply has **no per-request sandbox switch**: use an Oveyon API key already configured in sandbox to test replies without delivery. Held or quarantined messages may require a person's review in Oveyon; this node never releases quarantine or approves its own held message.

`accepted` means queued, not delivered. To observe delivery, use a delivery trigger. Sandbox accepts and freezes mail without delivering it and still consumes quota. A hold waits for human approval and expires according to its TTL.

### Idempotency and failures

Set an Idempotency Key tied to the business operation before sending or replying. Reuse exactly that key when retrying the same operation. Oveyon retains it for **24 hours from its first claim**, with separate send and reply namespaces. A later retry can create another message. The node never retries a write automatically. n8n's workflow retries or the node's Retry On Fail setting can repeat writes, so configure a stable key before enabling them.

A network timeout does not prove a write failed. Check Oveyon or retry with the same key. Errors from this node omit raw request headers, remote error text, and credentials. API policy, quota, quarantine, and authentication errors still need the corresponding change in Oveyon; retries cannot bypass them.

### Pagination and output

Get Many fetches pages of at most 100 items. Limit is the total across pages. Return All has a **10,000-item safety ceiling** and raises an error if more results remain; narrow the After/Before filters for larger datasets. Invalid, repeated, or empty-page cursors fail clearly. Cursors belong to the resource that generated them.

Simplify is enabled by default for Get and Get Many. Disable it for the complete API response fields. Inbound simplification keeps recipients, per-copy outcome, authentication, agent-safety, and quarantine context. List results reflect Oveyon's retention window; they are not an account-wide archive. Get Content preserves truncation flags and returns data, not rendered HTML.

## Webhook setup

The trigger is configured manually. It does not create, edit, or delete an endpoint in Oveyon, and does not need an API key. n8n manages the local URL; Oveyon manages its subscription. Use one event family and signing secret per trigger. The single Event Mode selector has three states: Inbound Setup, Inbound Live, and Delivery Live. Both Live states display the signing credential and event-processing notice; Setup hides them. New nodes default to Inbound Live, requiring a signing credential. Select Inbound Setup explicitly when registering a new inbound endpoint. An imported node without Event Mode also defaults to Live; an unsupported mode is refused.

### Receive inbound email

1. Add **Oveyon Trigger**. Set **Event Mode** to **Inbound Email: Setup (Challenge Only)**. No signing credential is needed yet.
2. Publish/activate the workflow. Copy its **Production URL**, not the temporary Test URL.
3. In the Oveyon inbound mailbox/channel configuration, add a webhook using that URL. Choose `inbound.received` and a summary payload. Oveyon sends an initial `url_verification` challenge before showing the secret.
4. Setup responds only to a small, correctly shaped challenge. It never starts the workflow and returns HTTP 503 for business events. Keep this setup interval short because Oveyon's retry window is finite.
5. Copy the secret shown once by Oveyon into a new **Oveyon Webhook API** credential.
6. Change **Event Mode** on the same trigger to **Inbound Email: Live (Signed Events)**, select that credential, and publish again. Keep the same node and Production URL.
7. Send a controlled email to the mailbox. Confirm one workflow execution contains `event: inbound.received` and its original `eventId`. Subsequent URL-verification challenges also require a valid signature in Live mode.

If the secret was lost, rotate/recreate the endpoint through Oveyon and update the credential. Never disable signature verification to recover a lost secret. Changing a node's webhook URL requires updating the Oveyon configuration as well.

### Receive delivery events

1. Add **Oveyon Trigger**, set **Event Mode** to **Delivery Events: Live (Signed Events)**, and select one or more of **Delivered, Bounced, Opened, Clicked, Complained, Blocked**.
2. Copy its Production URL into an Oveyon delivery-webhook endpoint, registering the same events.
3. Save that endpoint's secret in **Oveyon Webhook API**, select it, and publish the workflow. Delivery mode always requires a signing credential.
4. Generate a controlled event and confirm the workflow receives the original signed payload.

An authentic delivery event not selected in the node is acknowledged without starting a workflow. Unknown or mismatched event families are refused. If a workflow is disabled or deleted, also disable/delete its endpoint in Oveyon to stop retries to an unavailable URL.

### Verification, limits, and retries

Live mode verifies `x-oveyon-signature` against HMAC-SHA256 of `timestamp + '.' + rawBody`, using a timing-safe comparison. It requires the exact raw bytes, `application/json`, a timestamp within 300 seconds, a valid secret, and matching body/header event names. It rejects missing or altered data; it never signs a reconstructed JSON body. The event limit is **1 MiB**, and challenges are capped at **4 KiB**. Configure summary/full payloads within that budget; embedded attachment payloads are not supported by this version.

Setup is an intentionally unsigned bootstrap for the first inbound challenge only. It reflects only a 64-character hexadecimal challenge and never follows its URL, stores its body, or emits workflow data. Anyone who knows the Setup URL can ask for this harmless echo. Switch to Live promptly; Setup is not a mode for processing email.

Successful HTTP acknowledgement means n8n accepted the event, not that all downstream nodes succeeded. Oveyon may deliver an event more than once. Persistently deduplicate inbound events by `eventId` before side effects. Delivery event payloads have a different contract: do not invent an `eventId` or use the message ID alone when several event types can belong to one message. No in-memory cache is presented as exactly-once delivery.

Email text, HTML, URLs, and attachments remain third-party input even with a valid webhook signature. Do not render HTML unsanitized or treat email content as instructions to an AI agent. Choose n8n execution-retention and access settings appropriate for the email data you process.

### Test URLs

The Test URL exists only while n8n listens for a test event. Use it only with a temporary endpoint that you remove after testing. Use the Production URL for inbound bootstrap and ongoing delivery; it survives the change from Setup to Live on the same node. An unsigned challenge never becomes an execution item.

## Examples

Import the JSON files from [`examples`](./examples):

- `sandbox-send.json`: manual sandbox send. Replace example addresses, select a credential, and set a unique business idempotency key for each new operation.
- `inbound-setup.json`: inbound Setup trigger. Follow the setup steps, then switch the same node to Live.
- `delivery-events.json`: a delivery trigger with all six event types. Assign its signing credential before publishing.

The examples contain no credentials, are inactive by default, and do not automatically reply to received email.

## Development and release

The official n8n starter structure is used, with exact development dependency versions and a committed lockfile. There are no direct runtime dependencies besides the n8n-workflow peer supplied by n8n.

```sh
npm ci --ignore-scripts
npm run build
npm run lint
npm test
npm run scan
npm run pack:check
npm pack --ignore-scripts
```

`scan` runs the official static scanner on source and compiled output locally. It does not validate public npm provenance or approve the package. After release, run `npx @n8n/scan-community-package @oveyon/n8n-nodes-oveyon@0.1.0` against the published version and submit through the [n8n Creator Portal](https://creators.n8n.io/nodes).

The GitHub Actions workflow builds, tests, scans, inspects, then publishes with provenance. Configure npm trusted publishing for the exact repository and workflow first; the workflow does not contain a token. Publication and n8n approval require the maintainer's release process. A source repository URL in metadata is not evidence that the repository has already been created or made public.

## Support and license

Contact [support@oveyon.com](mailto:support@oveyon.com) for Oveyon account/API questions. Use the repository issue tracker once public for reproducible node problems; remove email content and all secrets before sharing a workflow or execution.

This package is [MIT licensed](./LICENSE). It does not change the license of the Oveyon service or other packages.
