# Test Fixtures

This directory contains reusable test data and mock objects.

## Purpose

Fixtures provide consistent, reusable test data across multiple test files, reducing duplication and making tests more maintainable.

## Usage Example

```javascript
// tests/fixtures/chains.fixture.js
export const mockChains = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    tags: ['L1']
  },
  {
    chainId: 137,
    name: 'Polygon',
    tags: ['L2']
  }
];

// In your test file
import { mockChains } from '../fixtures/chains.fixture.js';

describe('getAllChains', () => {
  it('should return chains', () => {
    const chains = getAllChains();
    expect(chains).toEqual(mockChains);
  });
});
```

## Fixture Types

- **chains.fixture.js** - Mock chain data
- **endpoints.fixture.js** - Mock RPC endpoints
- **relations.fixture.js** - Mock chain relations
- **responses.fixture.js** - Mock API responses
