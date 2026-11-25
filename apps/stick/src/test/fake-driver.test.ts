import { expect, test } from 'vitest';
import { fakeDriver } from './fake-driver.js';

test('the fake driver records the clone field in its started options', async () => {
  const d = fakeDriver([]);
  await d.driver.start({
    image: 'i',
    name: 'n',
    labels: {},
    payload: '{}',
    mirror: { volume: 'jm-mirror-d1-3-0123abcd', target: '/jm/mirror' },
    clone: true,
  });
  expect(d.started?.clone).toBe(true);
  expect(d.started?.mirror).toEqual({ volume: 'jm-mirror-d1-3-0123abcd', target: '/jm/mirror' });
});
