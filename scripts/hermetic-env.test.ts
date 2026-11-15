import { expect, test } from 'vitest';
import { CONTAINER_ENV } from '../vitest.setup.js';

test('unit tests run without the trooper container environment', () => {
  for (const name of CONTAINER_ENV) expect(process.env[name], name).toBeUndefined();
});
