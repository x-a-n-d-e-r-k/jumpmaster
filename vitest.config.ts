import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
