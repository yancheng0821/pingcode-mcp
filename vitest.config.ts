import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/e2e/**/*.test.ts'],
    setupFiles: ['./tests/unit/setup.ts'],
    testTimeout: 15000,
  },
});
