import { defineConfig } from 'vitest/config';
import { clearDropEnv } from './vitest.setup.js';

// Before any worker starts, so workers inherit an environment without the drop's settings (a
// Node version may read NODE_USE_ENV_PROXY only at startup).
clearDropEnv();

export default defineConfig({
  test: {
    // Clears the trooper image's drop settings, so tests behave the same inside a trooper container.
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // Repository-level tests. Workflow tests live under scripts/, never under .github/workflows/.
      'scripts/**/*.test.ts',
      'images/**/*.test.ts',
      'deploy/**/*.test.ts',
      'skills/**/*.test.ts',
    ],
  },
});
