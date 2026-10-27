# space-node-client

[![npm version](https://img.shields.io/npm/v/space-node-client.svg)](https://www.npmjs.com/package/space-node-client)

A TypeScript/Node.js client for interacting with the [SPACE pricing-driven self-adaptation solution](https://github.com/Alex-GF/space). This library allows you to connect to a SPACE server, manage contracts and evaluate features.

## Installation

```bash
npm install space-node-client
# or
yarn add space-node-client
# or
pnpm add space-node-client
```

## Features

- Manage user contracts and subscriptions
- Evaluate subscription compliance
- Manage usage levels to limit access of users to features
- TypeScript types included

## Quick Start

### 1. Connect to SPACE

> [!TIP]
> Check the [SPACE Documentation](https://pricing4saas-docs.vercel.app) for more details.

```typescript
import { connect, SpaceClient } from 'space-node-client';

const client: SpaceClient = connect({
  url: 'your_space_instance_url', // 'http://localhost:5403' (default local instance)
  apiKey: 'YOUR_API_KEY', // API key for authenticating SPACE requests
});

client.on('synchronized', () => {
  console.log('Connected and synchronized with SPACE!');
});
```

### 2. Add a Contract

```typescript
const contract = await client.contracts.addContract({
  userContact: {
    userId: 'user-123',
    username: 'testUser',
  },
  billingPeriod: {
    autoRenew: true,
    renewalDays: 30,
  },
  contractedServices: {
    tomatoMeter: '1.0.0',
  },
  subscriptionPlans: {
    tomatoMeter: 'ADVANCED',
  },
  subscriptionAddOns: {
    tomatoMeter: {
      extraTimers: 2,
    },
  },
});
```

### 3. Evaluate a Feature

```typescript
// Assuming you have a user with ID 'user-123' and
// a feature with ID 'tomatometer-pomodoroTimer'
const result = await client.features.evaluate('user-123', 'tomatometer-pomodoroTimer');
console.log(result.eval); // true/false
```

## API Overview

### SpaceClient

- `connect({ url, apiKey, organizationId? })` — Connects to the SPACE server and returns a `SpaceClient` instance. `organizationId` is only needed for member user keys (`usr_...`) and is sent with the `/contracts` events handshake.
- `SpaceClient.contracts.addContract(contract)` — Adds a new contract.
- `SpaceClient.contracts.updateContractSubscription(userId, subscription, { expectedContractVersion?, keepBillingPeriod?, rejectPrivate? })` — Updates a user's subscription (novation). On a SPACE that supports them (`X-Space-Capabilities` lists `contract-version` / `keep-billing-period` / `reject-private`): with `expectedContractVersion` the change only applies if nobody changed the contract meanwhile, otherwise it throws `ContractChangedError` (HTTP 412, or earlier if the contract read before the write already shows another version) carrying the current `contractVersion`; `keepBillingPeriod: true` keeps the current billing period instead of restarting it; `rejectPrivate: true` (opt-in, sent as `?rejectPrivate=true`) makes SPACE reject private plans and add-ons (`PRIVATE_PLAN` / `PRIVATE_ADDON`) instead of accepting them, which is what SPACE does by default. If the connected SPACE does not support a requested option, the call throws `SpaceFeatureUnsupportedError` (`capability`, `written: false`) and writes nothing; if the response shows the option was not honoured anyway (no `ETag`, or the billing period restarted), it throws `SpaceFeatureUnsupportedError` with `written: true` and the stored `contract`. Without options, the request is the same as before and no check is made.
- `SpaceClient.contracts.previewNovation(userId, subscription, { keepBillingPeriod?, rejectPrivate? })` — Dry run of a novation: returns `{ valid, errors, effective, versionChanges, usageWarnings, billingPeriod, contractVersion }` and writes nothing. `contractedServices` may be omitted to let SPACE keep the versions or apply the SPHERE policy. With `keepBillingPeriod` or `rejectPrivate`, throws `SpaceFeatureUnsupportedError` if the SPACE that answered does not advertise `keep-billing-period` or `reject-private`.
- `SpaceClient.contracts.getContract(userId)` fills `contractVersion` from the `ETag` header when the body lacks it.
- `SpaceClient.clearCapabilities()` — Forgets the cached `X-Space-Capabilities` (kept for 60 s per client), e.g. right after upgrading SPACE.
- `SpaceClient.features.evaluate(userId, featureId, expectedConsumption?)` — Evaluates a feature for a user.
- `SpaceClient.features.revertEvaluation(userId, featureId)` — Reverts the usage level update performed during a past evaluation. 

  > [!WARNING]
  > This will only take effect if the evaluation was done less that 2 mins ago, so it's expected to be used as rollback in case of an error during request processing in the host app

- `SpaceClient.features.generateUserPricingToken(userId)` — Evaluates all features that affect a user and returns a [Pricing Token](https://pricing4saas-docs.vercel.app/docs/2.0.1/api/understanding/communication).
- `SpaceClient.contracts.getPricings(userId)` — Returns the pricing version (plan, add-ons, status, YAML path) of every service in the user's contract, the version SPACE assigns to new contracts and the current `contractVersion`.
- `SpaceClient.pricings.getYaml(serviceName, pricingVersion, { etag? })` — Returns the raw Pricing2Yaml file of a version, byte for byte, with its `etag` and `syntaxVersion`. With `etag`, a 304 yields `{ notModified: true, yaml: null }`. Throws `PricingYamlUnavailableError` when SPACE cannot provide the original file, and `SpaceFeatureUnsupportedError` (`capability: 'pricing-yaml'`) when an older SPACE ignores `format=yaml` and answers with JSON.
- `SpaceClient.services.getNewContractsPricing(serviceName)` — Returns the version SPACE assigns to new contracts (`{ version, yamlUrl, source }`, `source` being `sphere-policy`, `default` or `latest-active`).

### Rendering a pricing page

```typescript
import { PricingYamlUnavailableError } from 'space-node-client';

// Signed-out visitor: the version new contracts get.
const { version } = await client.services.getNewContractsPricing('acme');

// Signed-in customer: the version of THEIR contract.
const { services, contractVersion } = await client.contracts.getPricings('user-123');
const current = services['acme']; // { version, status, plan, addOns, newContractsVersion, yamlUrl }

// The Pricing2Yaml to hand to the renderer (cache it by etag).
let cached = await client.pricings.getYaml('acme', current.version);
const refreshed = await client.pricings.getYaml('acme', current.version, { etag: cached.etag! });
if (!refreshed.notModified) cached = refreshed;
```

### Changing a subscription safely

```typescript
import { ContractChangedError, SpaceFeatureUnsupportedError } from 'space-node-client';

const candidate = {
  subscriptionPlans: { acme: 'pro' },
  subscriptionAddOns: { acme: { extraStorage: 1 } },
};

// 1. Preview: validation, effective versions, usage warnings. Nothing is written.
// rejectPrivate: a customer choosing their own plan must not pick a private (sales-only) one.
const options = { keepBillingPeriod: true, rejectPrivate: true };
const preview = await client.contracts.previewNovation('user-123', candidate, options);
if (!preview.valid) {
  return preview.errors; // [{ code: 'ADDON_NOT_AVAILABLE', service, path, message }, ...]
}

// 2. The user confirms; apply exactly what was previewed, guarded by the version it was computed on.
try {
  const contract = await client.contracts.updateContractSubscription('user-123', preview.effective, {
    ...options,
    expectedContractVersion: preview.contractVersion,
  });
} catch (error) {
  if (error instanceof ContractChangedError) {
    // Someone changed the contract in between (error.contractVersion is the current one):
    // preview again and ask the user to confirm.
  }
  if (error instanceof SpaceFeatureUnsupportedError) {
    // This SPACE cannot guarantee error.capability. error.written tells whether the novation
    // was applied anyway (post-write check) or nothing was sent.
  }
  throw error;
}
```

> [!NOTE]
> These endpoints need SPACE with the subscription-change API (`GET /contracts/{userId}/pricings`, `GET /services/{s}/pricings/{v}?format=yaml`, `GET /services/{s}/pricings/new-contracts`, `POST /contracts/{userId}/novation/preview`). Older SPACE versions answer 404 to them (`getYaml` throws `SpaceFeatureUnsupportedError`). The guarantees of `expectedContractVersion`, `keepBillingPeriod` and `rejectPrivate` hold only on a SPACE that advertises `contract-version`, `keep-billing-period` and `reject-private` in `X-Space-Capabilities`; against an older SPACE the client refuses those options with `SpaceFeatureUnsupportedError` instead of sending a novation the server would apply unconditionally (or with private plans accepted). `addContract` takes no options: `rejectPrivate` is not exposed for `POST /contracts` in this client.

### Events

SPACE is design to emit certain events every time a significant action occurs. Therefore, the node client provides an event listener interface to handle these events.

These are the events that can be listened:

- `synchronized` — Emitted when the client is connected and synchronized with the SPACE server.
- `pricing_created` — Emitted when a new pricing is added to SPACE.
- `pricing_actived` — Emitted when a pricing's availability has changed from archived to actived.
- `pricing_archived` — Emitted when a pricing's availability has changed from actived to archived.
- `service_disabled` — Emitted when a service is disabled in SPACE.
- `contract_created` — Emitted when a contract of your organisation is created.
- `contract_novated` — Emitted when a contract of your organisation changes subscription (novation).
- `contract_deleted` — Emitted when a contract of your organisation is deleted.
- `contract_renewed` — Emitted when a contract of your organisation renews its billing period.
- `resync` — Emitted every time a namespace (`pricings` or `contracts`) connects, with `{ namespace, reconnect }`. See [Delivery guarantees](#delivery-guarantees).
- `error` - Emitted when an error during the connection with SPACE.

The pricing events (`pricing_*`, `service_disabled`) bring a data object with the following structure:

```typescript
{
  serviceName: string; // REQUIRED. The name of the service that has triggered the event.
  pricingVersion: string; // OPTIONAL. If present, indicates the version of the pricing that has triggered the event.
}
```

This is how you declare a listener:

```typescript
client.on('pricing_archived', data => {
  console.log('Pricing archived!');
  console.log('Service Name:', data.serviceName);
  console.log('Pricing Version:', data.pricingVersion);
});
```

#### Contract events

Contract events travel over the authenticated `/contracts` namespace of SPACE, which only delivers the events of the organisation your API key belongs to. The client opens it the first time you register a contract listener, with `auth: { apiKey }` for an organisation key, or `auth: { apiKey, organizationId }` when you pass `organizationId` to `connect`/`new SpaceClient` (required by SPACE for member user keys, `usr_...`), so apps that do not listen to contract events keep a single unauthenticated connection. A rejected key is reported through the `error` listener. Before calling your listener, the client invalidates its cached contract, evaluations and pricing token for that user.

```typescript
import type { ContractEventDetails } from 'space-node-client';

client.on('contract_novated', (data: ContractEventDetails) => {
  // { userId, organizationId, contractVersion, services: string[] }
  // contractVersion is a string, or null for contract_deleted.
  notifyBrowserSessions(data.userId); // e.g. push a fresh pricing token to the user's tabs
});
```

> [!NOTE]
> Contract events need SPACE with the `/contracts` events namespace. Older versions reject the namespace and the `error` listener receives the connection error; pricing events are unaffected.

#### Event ids and occurredAt

Pricing and contract listeners get a second argument, `SpaceEventMeta`:

```typescript
import type { ContractEventDetails, SpaceEventMeta } from 'space-node-client';

client.on('contract_novated', (data: ContractEventDetails, meta: SpaceEventMeta) => {
  meta.code;          // 'CONTRACT_NOVATED'
  meta.eventId;       // '019a2a6b-7c1e-7d3f-9b2a-5c4e8f1a2b3c', the same in every copy of the event
  meta.occurredAt;    // Date: when SPACE stored the change
  meta.rawOccurredAt; // '2026-10-27T10:00:00.123Z', as sent
});
```

SPACE sends `eventId` and `occurredAt` from the version that advertises `contract-event-ids` in `X-Space-Capabilities`. With an older SPACE they are `undefined` (and so is `occurredAt` if the value is not a valid date). Listeners that take one argument keep working.

#### Delivery guarantees

SPACE events are hints that something changed, not a log of the changes:

- **At most once per connection, no replay.** An event goes to the connections open when it is emitted. While the client is disconnected or reconnecting, events are lost, and SPACE does not resend them.
- **Repeats are possible.** A consumer with several connections gets one copy per connection, all with the same `eventId`. The client drops a repeated `eventId` before invalidating the cache or calling your listener. It remembers the last 10,000 ids for up to 10 minutes (both namespaces share the window); events without `eventId` are always delivered. Each `SpaceClient` has its own window, so two clients (or two replicas of your backend) each get their copy, which is what each needs to refresh its own cache.
- **No ordering.** Events may arrive in another order than the changes were stored. Never order events by `eventId` (compare it for equality only) and do not compare `occurredAt` across SPACE instances, whose clocks may differ. `contractVersion` is a hash, not a counter.

So treat a contract event as a reason to re-read the contract (`client.contracts.getContract(userId)`), and compare its `contractVersion` with the one you hold: unchanged means nothing to do, and a 404 means it was deleted. A late, repeated or out-of-order event then costs one read and changes nothing.

After a reconnection, re-read the contracts you hold, because anything that changed while the client was disconnected was not announced. The `resync` event tells you when. When the `contracts` namespace reconnects, the client first invalidates the cached contracts, evaluations and pricing tokens of every user, so the reads below go to SPACE:

```typescript
import type { ResyncInfo } from 'space-node-client';

client.on('resync', ({ namespace, reconnect }: ResyncInfo) => {
  // reconnect is false on the first connection of a namespace, true after a reconnection.
  if (namespace === 'contracts' && reconnect) {
    void refreshCachedContracts(); // e.g. getContract() for each user you hold, comparing contractVersion
  }
});
```

If you read contracts before the first contract listener opened the namespace, re-read them on the first `resync` too.

The deduplication window is configurable, or can be turned off:

```typescript
const client = connect({
  url: 'http://localhost:5403',
  apiKey: 'your-api-key',
  eventDeduplication: { maxEntries: 50_000, windowMs: 30 * 60_000 }, // or false to deliver every copy
});
```

### Pricing token payload

`PricingTokenPayload` types the decoded pricing token. Tokens issued by SPACE versions with the subscription-change API also carry `subscription` (the contracted versions, plans, add-ons and the `contractVersion` at issue time); it is optional so older tokens still type-check.

```typescript
import type { PricingTokenPayload } from 'space-node-client';

const token = await client.features.generateUserPricingToken('user-123');
// Decoded, NOT verified: fine for reading your own freshly issued token. To trust a token that came
// back from a browser, verify its signature (e.g. with a JWT library and SPACE's signing secret).
const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as PricingTokenPayload;
payload.subscription?.subscriptionPlans.acme; // 'pro'
```

## Tests

`pnpm test` runs the whole suite; most suites expect a SPACE instance on `http://localhost:3000` (see `src/test/lib/axios.ts`) and Redis for the Redis suite. `pnpm test:mocked` runs only the suites under `src/test/mocked`, which start an in-process HTTP and Socket.IO server that mimics SPACE and need nothing else.

## TypeScript Support

This library is fully typed. Types for contracts, features, pricing, and more are included and exported.

## Tech Stack

This project uses the following main tools and technologies:

<div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: space-evenly;">

![TypeScript](https://img.shields.io/badge/-TypeScript-3178C6?logo=typescript&logoColor=white&style=for-the-badge)
![Axios](https://img.shields.io/badge/-Axios-5A29E4?logo=axios&logoColor=white&style=for-the-badge)
![Vitest](https://img.shields.io/badge/-Vitest-6E9F18?logo=vitest&logoColor=white&style=for-the-badge)
![Prettier](https://img.shields.io/badge/-Prettier-F7B93E?logo=prettier&logoColor=white&style=for-the-badge)
![ESLint](https://img.shields.io/badge/-ESLint-4B32C3?logo=eslint&logoColor=white&style=for-the-badge)
![pnpm](https://img.shields.io/badge/-pnpm-F69220?logo=pnpm&logoColor=white&style=for-the-badge)

</div>

## Disclaimer & License

> **LICENSE**  
> This project is licensed under the MIT License. See [LICENSE](./LICENSE) for details

> **DISCLAIMER**
> This tool is part of ongoing research by the [ISA group](https://github.com/isa-group) in pricing-driven development and operation of SaaS. It is in a **very early stage** and is not intended for production use. The ISA group does not accept responsibility for any issues or damages that may arise from its use in real-world environments