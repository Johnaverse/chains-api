# Test Helpers

This directory contains reusable test utility functions and helpers.

## Purpose

Helpers provide common functionality needed across multiple test files, such as:
- Mock factories
- Setup/teardown utilities
- Custom assertions
- Test data generators

## Usage Example

```javascript
// tests/helpers/server.helper.js
import Fastify from 'fastify';

export async function createTestServer() {
  const fastify = Fastify({ logger: false });
  // Setup routes
  await fastify.listen({ port: 0 });
  return fastify;
}

export async function closeTestServer(fastify) {
  await fastify.close();
}

// In your test file
import { createTestServer, closeTestServer } from '../helpers/server.helper.js';

describe('API Tests', () => {
  let server;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await closeTestServer(server);
  });
});
```

## Helper Types

- **server.helper.js** - Test server utilities
- **mock.helper.js** - Mock factories
- **assertion.helper.js** - Custom assertions
- **data.helper.js** - Test data generators
