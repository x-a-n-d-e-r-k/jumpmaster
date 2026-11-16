import { defineConfig } from 'vitest/config';
import { clearDropEnv } from './vitest.setup.js';

// Before any worker starts, so workers inherit an environment without the drop's settings (a
// Node version may read NODE_USE_ENV_PROXY only at startup).
clearDropEnv();

export default defineConfig({
  test: {
    // Clears the trooper image's drop settings, so tests behave the same inside a trooper container.
    setupFiles: ['./vitest.setup.ts'],
    // Gates run on every stick, and a slower host (WSL's Docker, a busy laptop) can take ~100x a
    // fast one for a test that syncs a SQLite file. 5 s failed correct changes there; 20 s doesn't.
    testTimeout: 20_000,
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
