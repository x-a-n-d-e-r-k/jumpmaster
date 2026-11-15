import { defineConfig } from 'vitest/config';

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
