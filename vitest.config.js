import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/noNetworkDns.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'public/',
        '**/*.test.js',
        '**/*.config.js'
      ]
    },
    testTimeout: 30000,
    hookTimeout: 30000
  }
});
