# Fuzz Testing Documentation

## Overview

Fuzz testing (fuzzing) is an automated software testing technique that provides invalid, unexpected, or random data as inputs to discover security vulnerabilities, crashes, and unexpected behaviors.

## Fuzz Test Coverage

### Property-Based Testing
Uses `fast-check` library to generate hundreds of random inputs per test case.

### Test Categories

#### 1. **Input Validation Fuzzing**
- Random strings, integers, floats
- Special characters and edge cases
- Empty strings, null, undefined
- Very long inputs (100K+ characters)
- Mixed data types

#### 2. **Security Fuzzing**
- **SQL Injection attempts**: `' OR '1'='1`, `1; DROP TABLE--`
- **XSS attempts**: `<script>alert('XSS')</script>`
- **Path traversal**: `../../../etc/passwd`
- **Header injection**: Malformed headers
- **Buffer overflow**: Extremely long inputs

#### 3. **HTTP Method Fuzzing**
- Tests all endpoints with invalid HTTP methods (POST, PUT, DELETE on GET endpoints)
- Ensures proper error handling

#### 4. **Unicode and Encoding**
- Unicode strings: 🔥💻🚀
- International characters: 测试, тест, اختبار
- Special characters: ∀x∈ℝ
- Emoji combinations: 👨‍👩‍👧‍👦

#### 5. **Parameter Fuzzing**
- Missing required parameters
- Extra unexpected parameters
- Malformed query strings
- Multiple values for single parameter

## Endpoints Tested

All API endpoints are fuzz tested:

### GET /chains/:id
- ✅ Random integers, strings, floats
- ✅ SQL injection attempts
- ✅ Path traversal attempts
- ✅ Special characters
- ✅ Very large numbers

### GET /search?q=
- ✅ Any string input (including special chars)
- ✅ Mixed type queries
- ✅ Very long queries (1000+ chars)
- ✅ XSS attempts
- ✅ Unicode strings
- ✅ Missing query parameter

### GET /chains?tag=
- ✅ Optional tag parameter
- ✅ Multiple query parameters
- ✅ Invalid tag values

### GET /relations/:id
- ✅ Any input type
- ✅ Extreme integer ranges
- ✅ Invalid ID formats

### GET /endpoints/:id
- ✅ Natural numbers
- ✅ Invalid formats
- ✅ Very large IDs

### GET /rpc-monitor/:id
- ✅ Any input type
- ✅ Invalid ID formats

## Running Fuzz Tests

### Run all fuzz tests
```bash
npx vitest run tests/integration/api.fuzz.test.js
```

### Run with verbose output
```bash
npx vitest run tests/integration/api.fuzz.test.js --reporter=verbose
```

### Run specific fuzz test suite
```bash
npx vitest run tests/integration/api.fuzz.test.js -t "SQL Injection"
```

### Run in watch mode
```bash
npx vitest tests/integration/api.fuzz.test.js
```

## Understanding Test Output

### Successful Test
```
✓ should handle any input gracefully (100 runs)
```
Each property-based test runs 100 times by default with different random inputs.

### Failed Test
When a test fails, fast-check provides:
- **Counterexample**: The input that caused the failure
- **Seed**: To reproduce the exact failure
- **Shrunk value**: Simplified version of the failing input

Example:
```
Property failed after 42 runs with seed 123456789
Counterexample: "特殊字符"
Shrunk 3 times to: "\u0000"
```

## Security Vulnerabilities Detected

Fuzz testing helps detect:

### 1. **Injection Attacks**
- SQL injection
- NoSQL injection
- Command injection
- LDAP injection

### 2. **Cross-Site Scripting (XSS)**
- Reflected XSS
- Stored XSS
- DOM-based XSS

### 3. **Path Traversal**
- Directory traversal
- File inclusion

### 4. **Denial of Service (DoS)**
- Buffer overflow
- Resource exhaustion
- Infinite loops

### 5. **Input Validation Issues**
- Type confusion
- Integer overflow
- Format string bugs

## Expected Behaviors

### Valid Input
- Status: 200 OK
- Response: Valid JSON with expected structure

### Invalid Input
- Status: 400 Bad Request
- Response: `{ "error": "descriptive message" }`

### Not Found
- Status: 404 Not Found
- Response: `{ "error": "not found message" }`

### Never Expected
- ❌ Status: 500 Internal Server Error (should never crash)
- ❌ Unhandled exceptions
- ❌ Timeout or hang
- ❌ Malformed JSON response

## Customizing Fuzz Tests

### Adjust number of runs
```javascript
test.prop([fc.string()], { numRuns: 1000 })('test name', async (input) => {
  // Test with 1000 random inputs instead of default 100
});
```

### Custom generators
```javascript
import { fc } from 'fast-check';

// Generate only SQL-like strings
const sqlStrings = fc.constantFrom(
  "SELECT * FROM users",
  "DELETE FROM",
  "'; DROP TABLE--"
);

test.prop([sqlStrings])('test SQL inputs', async (sql) => {
  // Test logic
});
```

### Reproduce specific failure
```javascript
test.prop([fc.string()], { seed: 123456789 })('reproduce bug', async (input) => {
  // Will use the same seed to generate same random values
});
```

## Best Practices

### 1. **Always Check Status Codes**
```javascript
expect([200, 400, 404]).toContain(response.statusCode);
expect(response.statusCode).not.toBe(500); // Never crash
```

### 2. **Validate JSON Responses**
```javascript
expect(() => JSON.parse(response.payload)).not.toThrow();
```

### 3. **Check for Information Leakage**
```javascript
if (response.statusCode === 500) {
  const data = JSON.parse(response.payload);
  expect(data).not.toHaveProperty('stack'); // Don't leak stack traces
}
```

### 4. **Test Security Headers**
```javascript
expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
```

### 5. **Performance Testing**
```javascript
const startTime = Date.now();
await makeRequest();
const duration = Date.now() - startTime;
expect(duration).toBeLessThan(1000); // Should respond within 1 second
```

## CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
- name: Run Fuzz Tests
  run: npx vitest run tests/integration/api.fuzz.test.js
  continue-on-error: false  # Fail build on fuzz test failure
```

## Reporting Issues

When fuzz testing discovers a bug:

1. **Note the seed**: Allows reproduction
2. **Document the input**: What caused the failure
3. **Capture the response**: Status code, body, headers
4. **Create minimal reproduction**: Simplify the failing case
5. **Add regression test**: Prevent future occurrence

## Resources

- [fast-check Documentation](https://fast-check.dev/)
- [OWASP Testing Guide](https://owasp.org/www-project-web-security-testing-guide/)
- [Fuzzing Best Practices](https://owasp.org/www-community/Fuzzing)
- [Security Testing](https://cheatsheetseries.owasp.org/cheatsheets/Testing_Cheat_Sheet.html)

## Maintenance

### Update fuzz tests when:
- Adding new endpoints
- Changing input validation
- Modifying error handling
- Security patches are applied

### Review fuzz results:
- Weekly for active development
- Before each release
- After security updates
- When bugs are reported
