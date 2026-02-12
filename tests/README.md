# Tests Directory

This directory contains all tests for the Chains API project, organized by test type.

## Directory Structure

```
tests/
├── unit/                   # Unit tests for individual modules
│   ├── dataService.test.js # Tests for data service functions
│   └── rpcMonitor.test.js  # Tests for RPC monitoring functions
├── integration/            # Integration tests for API endpoints
│   └── api.test.js        # Tests for all REST API endpoints
├── fixtures/              # Test data and mocks
│   └── (test data files)
└── helpers/               # Test utility functions
    └── (helper files)
```

## Test Types

### Unit Tests (`tests/unit/`)
- Test individual functions in isolation
- Mock external dependencies
- Fast execution (~ms)
- Focus: Internal logic, data transformations, validations

### Integration Tests (`tests/integration/`)
- Test API endpoints end-to-end
- Test module interactions
- Moderate execution time (~100-500ms)
- Focus: Request/response cycles, error handling, data flow

### Fixtures (`tests/fixtures/`)
- Reusable test data
- Mock responses
- Sample chain data
- Configuration mocks

### Helpers (`tests/helpers/`)
- Test utility functions
- Common setup/teardown
- Assertion helpers
- Mock factories

## Running Tests

### All tests
```bash
npm test
```

### Unit tests only
```bash
npx vitest run tests/unit
```

### Integration tests only
```bash
npx vitest run tests/integration
```

### Specific test file
```bash
npx vitest run tests/unit/dataService.test.js
```

### Watch mode
```bash
npm run test:watch
```

### Coverage report
```bash
npm run test:coverage
```

## Writing New Tests

### Unit Test Example
Create a file in `tests/unit/` following the pattern `<module>.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { functionName } from '../../moduleName.js';

describe('Module Name', () => {
  describe('functionName', () => {
    it('should do something', () => {
      const result = functionName('input');
      expect(result).toBe('expected');
    });
  });
});
```

### Integration Test Example
Create a file in `tests/integration/`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

describe('API Endpoint', () => {
  beforeAll(async () => {
    // Setup
  });

  afterAll(async () => {
    // Cleanup
  });

  it('should return expected response', async () => {
    // Test implementation
  });
});
```

## Best Practices

1. **One describe per module/feature**
2. **Descriptive test names** - "should X when Y"
3. **AAA pattern** - Arrange, Act, Assert
4. **Test isolation** - Each test should be independent
5. **Mock external dependencies** - No real network calls
6. **Clean up** - Use afterEach/afterAll hooks
7. **Keep tests simple** - One assertion per test when possible

## Naming Conventions

- **Test files**: `<module>.test.js` or `<feature>.test.js`
- **Describe blocks**: Module or feature name
- **Test cases**: Start with "should"
- **Helpers**: `<purpose>.helper.js`
- **Fixtures**: `<data-type>.fixture.js`

## Coverage Goals

- **Unit tests**: 80%+ coverage
- **Integration tests**: All endpoints covered
- **Critical paths**: 100% coverage

## Debugging

### Run with verbose output
```bash
npx vitest run --reporter=verbose
```

### Run single test
```bash
npx vitest run -t "test name"
```

### Debug in VS Code
Add to `.vscode/launch.json`:
```json
{
  "type": "node",
  "request": "launch",
  "name": "Debug Tests",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "test"],
  "console": "integratedTerminal"
}
```
