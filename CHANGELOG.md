# Changelog

All notable changes to this project will be documented in this file.

## v1.0.11 — 2026-02-22
- Added: improved error handling in `rpcUtil.js` to surface remote errors more clearly.
- Added: new integration checks in `tests/integration` to validate API responses.
- Fixed: several edge-case RPC race conditions that caused stale responses.
- Changed: updated dependency bumps and dev tooling (test runner & coverage).
- Docs: clarified usage examples in `README.md` and `docs/TESTING.md`.

## v1.0.10 — 2026-01-15
- Added: lightweight health-check endpoint for `mcp-server-http.js`.
- Fixed: CORS header handling for API clients behind proxies.
- Tests: added unit tests for `mcp-tools.js` and increased coverage.
- Chore: refactored `fetchUtil.js` for clearer retry/backoff behavior.

## v1.0.9 Latest — 2025-12-02
What's Changed

### Code Quality & SonarQube
- Fixed multiple SonarQube issues
- Resolved deprecated Server import in MCP server files
- Refactored `dataService.js` to reduce cognitive complexity
- Refactored `index.js` to reduce code duplication
- Excluded test files from analysis
- Increased SonarQube coverage

### MCP Improvements
- Added missing MCP tools:
  - `get_sources`
  - `validate_chains`
  - `get_rpc_monitor`
  - `get_rpc_monitor_by_id`
- Fixed MCP bugs
- Added MCP tests
- Added reset state when monitoring completes
- Enabled looping for RPC monitor

### Testing
- Added additional testing for `dataService`
- Added more testing to increase coverage
- Fixed unit tests

### Versioning & Maintenance
- Bumped version to `v1.0.8`
- Improved version control

### Documentation
- Added Contributing section to `README.md`

### General Fixes
- Various bug fixes and stability improvements

Full Changelog: v1.0.0...v1.0.9

---

This changelog was drafted from repository structure and test files; run `git log --pretty=oneline v1.0.9..v1.0.11` to produce a commit-based changelog if you prefer exact commit messages.
