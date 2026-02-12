import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        '**/*.test.js',
        '**/*.config.js',
        'mcp-server.js',
        'mcp-server-http.js'
      ]
    },
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
