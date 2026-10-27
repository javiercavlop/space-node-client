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

- `connect({ url, apiKey })` — Connects to the SPACE server and returns a `SpaceClient` instance.
- `SpaceClient.contracts.addContract(contract)` — Adds a new contract.
- `SpaceClient.contracts.updateContractSubscription(userId, subscription)` — Updates a user's subscription.
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

> [!NOTE]
> These endpoints need SPACE with the subscription-change API (`GET /contracts/{userId}/pricings`, `GET /services/{s}/pricings/{v}?format=yaml`, `GET /services/{s}/pricings/new-contracts`). Older SPACE versions answer 404 (and `getYaml` throws `SpaceFeatureUnsupportedError`).

### Events

SPACE is design to emit certain events every time a significant action occurs. Therefore, the node client provides an event listener interface to handle these events.

These are the events that can be listened:

- `synchronized` — Emitted when the client is connected and synchronized with the SPACE server.
- `pricing_created` — Emitted when a new pricing is added to SPACE.
- `pricing_actived` — Emitted when a pricing's availability has changed from archived to actived.
- `pricing_archived` — Emitted when a pricing's availability has changed from actived to archived.
- `service_disabled` — Emitted when a service is disabled in SPACE.
- `error` - Emitted when an error during the connection with SPACE.

All events, except `synchronized` and `error`, brings a data object with the following structure:

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