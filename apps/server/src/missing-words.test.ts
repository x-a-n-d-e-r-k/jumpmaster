import { describe, expect, test } from 'vitest';
import { missingWords } from './missing-words.js';

describe('missingWords (#871)', () => {
  test('clone-v1 names the capability and says what it is for', () => {
    expect(missingWords('clone-v1')).toBe(
      "clone-v1 (the clone container a GitLab project's drops need)",
    );
  });

  test('every other item reads as before', () => {
    expect(missingWords('egress-v1')).toBe('egress-v1');
    expect(missingWords('image-verify-v1')).toBe('image-verify-v1');
    expect(missingWords('image-policy:signed')).toBe('image-policy:signed');
    expect(missingWords('egress-ceiling:a.example.com+b.example.com')).toBe(
      "a.example.com, b.example.com in the stick's JM_EGRESS_CEILING",
    );
    expect(missingWords('egress-ceiling:mode')).toBe(
      "egress set to enforce (the stick's JM_EGRESS_CEILING requires it)",
    );
  });
});
