# Project Structure

## 📁 Complete Directory Layout

```
chains-api/
│
├── 📂 tests/                          # All test files (organized)
│   ├── 📂 unit/                       # Unit tests for modules
│   │   ├── dataService.test.js        # 31 tests
│   │   └── rpcMonitor.test.js         # 14 tests
│   │
│   ├── 📂 integration/                # Integration/API tests
│   │   └── api.test.js                # 19 tests
│   │
│   ├── 📂 fixtures/                   # Reusable test data
│   │   └── README.md
│   │
│   ├── 📂 helpers/                    # Test utilities
│   │   └── README.md
│   │
│   └── 📄 README.md                   # Tests overview
│
├── 📂 node_modules/                   # Dependencies (gitignored)
│
├── 📂 coverage/                       # Test coverage reports (gitignored)
│
├── 📄 index.js                        # Main API server (Fastify)
├── 📄 dataService.js                  # Data loading & indexing
├── 📄 rpcMonitor.js                   # RPC endpoint monitoring
├── 📄 mcp-server.js                   # MCP server (stdio)
├── 📄 mcp-server-http.js              # MCP server (HTTP)
│
├── 📄 package.json                    # Project config & scripts
├── 📄 package-lock.json               # Dependency lock file
├── 📄 vitest.config.js                # Test configuration
│
├── 📄 TESTING.md                      # Testing guide (updated)
├── 📄 TEST_SUMMARY.md                 # Test results summary
├── 📄 PROJECT_STRUCTURE.md            # This file
│
├── 📄 README.md                       # Project documentation
└── 📄 .gitignore                      # Git ignore rules

```

## 🎯 Benefits of New Structure

### ✅ Organized & Scalable
- **Separation of concerns** - Tests separated from source code
- **Easy navigation** - Clear hierarchy (unit/integration/fixtures/helpers)
- **Scalable** - Easy to add new test files in appropriate directories

### ✅ Professional Standards
- **Industry standard** - Follows common Node.js project structure
- **Clear purpose** - Each directory has a specific role
- **Documented** - README in each directory explaining its purpose

### ✅ Better DX (Developer Experience)
- **Easy to find tests** - All in `tests/` directory
- **Filtered test runs** - Run unit or integration tests separately
- **Reusable code** - Fixtures and helpers prevent duplication

### ✅ CI/CD Friendly
- **Selective testing** - Run only unit tests in CI for speed
- **Clear reporting** - Test output shows directory structure
- **Coverage tracking** - Easy to see which modules need more tests

## 📊 Test Organization

### Unit Tests (`tests/unit/`)
```
Purpose: Test individual functions in isolation
Speed: Fast (< 10ms per file)
Mocking: Heavy (mock all external dependencies)
Coverage: Internal logic, data transformations
```

### Integration Tests (`tests/integration/`)
```
Purpose: Test API endpoints end-to-end
Speed: Moderate (100-500ms per file)
Mocking: Minimal (test real interactions)
Coverage: Request/response cycles, error handling
```

### Fixtures (`tests/fixtures/`)
```
Purpose: Reusable test data
Usage: Import in multiple test files
Examples: Mock chains, endpoints, responses
```

### Helpers (`tests/helpers/`)
```
Purpose: Test utility functions
Usage: Common setup/teardown, assertions
Examples: Server setup, mock factories
```

## 🚀 Running Tests

### All tests
```bash
npm test                                    # All 64 tests
```

### By type
```bash
npx vitest run tests/unit                  # Unit tests only (45 tests)
npx vitest run tests/integration           # Integration tests only (19 tests)
```

### By file
```bash
npx vitest run tests/unit/dataService.test.js       # 31 tests
npx vitest run tests/unit/rpcMonitor.test.js        # 14 tests
npx vitest run tests/integration/api.test.js        # 19 tests
```

### Watch mode
```bash
npm run test:watch                         # Auto-rerun on changes
```

### Coverage
```bash
npm run test:coverage                      # Generate coverage report
```

## 📝 File Naming Conventions

### Test Files
- `<module>.test.js` - Unit tests
- `<feature>.test.js` - Integration tests
- Location: `tests/unit/` or `tests/integration/`

### Fixtures
- `<data-type>.fixture.js`
- Location: `tests/fixtures/`
- Export: Named exports

### Helpers
- `<purpose>.helper.js`
- Location: `tests/helpers/`
- Export: Named exports

### Source Files
- `<module>.js` - Source code
- Location: Project root
- Pattern: camelCase

## 🔄 Import Paths

### From unit tests
```javascript
import { function } from '../../module.js';      // Source code
import { mockData } from '../fixtures/data.fixture.js';  // Fixture
import { helper } from '../helpers/util.helper.js';      // Helper
```

### From integration tests
```javascript
import { function } from '../../module.js';      // Source code
import { mockData } from '../fixtures/data.fixture.js';  // Fixture
```

## 📈 Growth Plan

### Phase 1: Current ✅
- [x] 64 tests across 3 files
- [x] Organized directory structure
- [x] Unit and integration tests
- [x] Documentation

### Phase 2: Next Steps
- [ ] Add fixtures for common test data
- [ ] Add helpers for server setup
- [ ] Increase coverage to 80%+
- [ ] Add performance tests

### Phase 3: Advanced
- [ ] E2E tests with real data sources
- [ ] Load testing
- [ ] Security testing
- [ ] Mutation testing

## 📚 Documentation Files

| File | Purpose |
|------|---------|
| [TESTING.md](./TESTING.md) | Complete testing guide |
| [TEST_SUMMARY.md](./TEST_SUMMARY.md) | Test results & coverage |
| [tests/README.md](./tests/README.md) | Test directory overview |
| [tests/fixtures/README.md](./tests/fixtures/README.md) | Fixtures guide |
| [tests/helpers/README.md](./tests/helpers/README.md) | Helpers guide |
| [PROJECT_STRUCTURE.md](./PROJECT_STRUCTURE.md) | This file |

## 🎓 Best Practices Enforced

✅ **Separation of Concerns**
- Tests separated from source code
- Unit tests separated from integration tests

✅ **DRY Principle**
- Fixtures for reusable data
- Helpers for common utilities

✅ **Single Responsibility**
- Each test file tests one module
- Each test case tests one behavior

✅ **Clear Naming**
- Descriptive file names
- "should X when Y" test names

✅ **Documentation**
- README in each directory
- Inline comments where needed

## 🔗 Related Commands

```bash
# Development
npm start                 # Start API server
npm run dev              # Start with auto-reload

# Testing
npm test                 # Run all tests
npm run test:watch       # Watch mode
npm run test:coverage    # Coverage report

# MCP Servers
npm run mcp              # Start MCP server (stdio)
npm run mcp:http         # Start MCP server (HTTP)
```

## 📊 Project Stats

- **Total Files**: 11 source + 3 test files
- **Total Tests**: 64 tests (all passing ✅)
- **Test Coverage**: Unit (45) + Integration (19)
- **LOC**: ~2000+ lines of code
- **Dependencies**: Fastify, Vitest, MCP SDK

---

**Structure Last Updated**: 2025
**All Tests Passing**: ✅ 64/64
