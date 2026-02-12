# Testing Documentation

This project uses [Vitest](https://vitest.dev/) for unit and integration testing.

## Directory Structure

```
chains-api/
├── tests/
│   ├── unit/                      # Unit tests for individual modules
│   │   ├── dataService.test.js    # Data service function tests
│   │   └── rpcMonitor.test.js     # RPC monitoring function tests
│   ├── integration/               # Integration tests for API endpoints
│   │   └── api.test.js           # REST API endpoint tests
│   ├── fixtures/                  # Reusable test data and mocks
│   │   └── README.md
│   ├── helpers/                   # Test utility functions
│   │   └── README.md
│   └── README.md                 # Tests directory overview
├── src files (index.js, etc.)
├── vitest.config.js              # Vitest configuration
├── TESTING.md                    # This file
└── TEST_SUMMARY.md              # Test results summary
```

## Test Files Overview

### Unit Tests (`tests/unit/`)

**`rpcMonitor.test.js`** (14 tests)
- URL validation and filtering
- RPC call handling (success, errors, timeouts)
- Real-time monitoring updates
- Chain endpoint limiting
- Error handling

**`dataService.test.js`** (31 tests)
- Data caching and retrieval
- Chain search (by ID, name, case-insensitive)
- Relations mapping (l1Of, l2Of, testnetOf)
- Endpoints extraction (RPC, firehose, substreams)
- Data transformation and merging
- SLIP-0044 parsing and tag handling

### Integration Tests (`tests/integration/`)

**`api.test.js`** (19 tests)
- All REST API endpoints
- Query parameter validation
- Error responses (400, 404)
- Request/response cycles
- Tag filtering
- Search functionality

## Running Tests

### Run all tests
```bash
npm test
```

### Run unit tests only
```bash
npx vitest run tests/unit
```

### Run integration tests only
```bash
npx vitest run tests/integration
```

### Run specific test file
```bash
npx vitest run tests/unit/dataService.test.js
```

### Watch mode (auto-rerun on changes)
```bash
npm run test:watch
```

### Coverage report
```bash
npm run test:coverage
```

### Run tests matching pattern
```bash
npx vitest run -t "RPC Monitor"
```

## Test Coverage

Coverage reports are generated in the `coverage/` directory and include:
- **Line coverage** - Percentage of lines executed
- **Branch coverage** - Percentage of branches (if/else) taken
- **Function coverage** - Percentage of functions called
- **Statement coverage** - Percentage of statements executed

### Current Coverage
- **Total Tests**: 64
- **Test Files**: 3
- **Status**: ✅ All Passing

## Writing New Tests

### Unit Test Example

Create in `tests/unit/<module>.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { functionName } from '../../moduleName.js';

describe('Module Name', () => {
  describe('functionName', () => {
    it('should do something when condition', () => {
      // Arrange
      const input = 'test';

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toBe('expected');
    });
  });
});
```

### Integration Test Example

Create in `tests/integration/<feature>.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('API Feature', () => {
  let server;

  beforeAll(async () => {
    // Setup test server
  });

  afterAll(async () => {
    // Cleanup
    await server.close();
  });

  it('should return expected response', async () => {
    const response = await server.inject({
      method: 'GET',
      url: '/endpoint'
    });

    expect(response.statusCode).toBe(200);
  });
});
```

### Using Fixtures

Create reusable test data in `tests/fixtures/`:

```javascript
// tests/fixtures/chains.fixture.js
export const mockChains = [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 137, name: 'Polygon' }
];

// In test file
import { mockChains } from '../fixtures/chains.fixture.js';
```

### Using Helpers

Create utilities in `tests/helpers/`:

```javascript
// tests/helpers/server.helper.js
export async function createTestServer() {
  // Setup logic
}

// In test file
import { createTestServer } from '../helpers/server.helper.js';
```

## Mocking

### Mock Modules
```javascript
import { vi } from 'vitest';

vi.mock('../../dataService.js', () => ({
  getCachedData: vi.fn(() => ({ chains: [] }))
}));
```

### Mock Functions
```javascript
const mockFn = vi.fn(() => 'mocked value');
expect(mockFn).toHaveBeenCalledWith('arg');
```

### Mock Global fetch
```javascript
global.fetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: async () => ({ result: 'data' })
  })
);
```

## Continuous Integration

Add to your CI/CD pipeline:

```yaml
# .github/workflows/test.yml
- name: Run tests
  run: npm test

- name: Generate coverage
  run: npm run test:coverage
```

Exit codes:
- `0` = All tests passed ✅
- `1` = Tests failed ❌

## Best Practices

### Test Organization
1. **Group related tests** - Use nested `describe` blocks
2. **One assertion per test** - When possible
3. **Clear test names** - "should X when Y"
4. **AAA pattern** - Arrange, Act, Assert

### Test Isolation
1. **Independent tests** - Don't rely on test order
2. **Clean state** - Reset mocks in `beforeEach`
3. **Cleanup** - Use `afterEach`/`afterAll`

### Mocking Strategy
1. **Mock external calls** - No real network requests
2. **Mock at boundaries** - API calls, database, file system
3. **Don't over-mock** - Test real internal logic

### Coverage Goals
- **Unit tests**: 80%+ coverage
- **Integration tests**: All endpoints covered
- **Critical paths**: 100% coverage

## Debugging Tests

### Verbose output
```bash
npx vitest run --reporter=verbose
```

### Single test
```bash
npx vitest run -t "specific test name"
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Vitest Tests",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "test"],
  "console": "integratedTerminal",
  "internalConsoleOptions": "neverOpen"
}
```

### Console logs
Tests suppress logs by default. To see them:
```javascript
console.log('Debug info'); // Will show in test output
```

## Common Issues

### Tests timing out
- Increase timeout in `vitest.config.js`
- Use `{ timeout: 30000 }` in specific tests

### Import errors
- Check relative paths: `../../module.js`
- Ensure mocks match import paths

### Mock not working
- Mock before importing the module
- Check mock path matches import path

### Async tests failing
- Use `async/await` properly
- Return promises from tests

## Resources

- [Vitest Documentation](https://vitest.dev/)
- [Testing Best Practices](https://github.com/goldbergyoni/javascript-testing-best-practices)
- [Test Directory README](./tests/README.md)
- [Test Summary](./TEST_SUMMARY.md)
