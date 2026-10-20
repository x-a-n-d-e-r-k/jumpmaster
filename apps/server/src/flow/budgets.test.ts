import { beforeEach, describe, expect, test } from 'vitest';
import type { Budgets } from '../config.js';
import { type Db, openDb } from '../db/open.js';
import { getAttempts, upsertDropZone, upsertWorkItem } from '../db/repo.js';
import { t0, tmpDbFile } from '../test/helpers.js';
import {
  chargeBudget,
  chargeNoChange,
  chargeRateLimitRequeue,
  chargeResolveConflict,
  fingerprint,
  RATE_LIMIT_REQUEUE_MAX,
  refundCharge,
} from './budgets.js';

const b: Budgets = {
  maxHeal: 3,
  maxResolve: 2,
  maxResolveTotal: 6,
  maxResume: 2,
  maxReviewRepeat: 2,
  maxNoChange: 1,
};

let db: Db;
let id: number;

beforeEach(() => {
  db = openDb(tmpDbFile());
  upsertDropZone(db, { id: 'main', repo: 'octo/demo', defaultBranch: 'main', configJson: '{}' });
  id = upsertWorkItem(db, {
    dropZoneId: 'main',
    issueNumber: 1,
    title: 'Issue 1',
    body: 'b',
    author: 'alice',
    priority: 0,
    isFix: false,
    issueCreatedAt: t0.toISOString(),
  }).id;
});

describe('fingerprint', () => {
  test('is a stable 16-hex digest that separates parts', () => {
    expect(fingerprint(['a', 1, null])).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(['a', 'b'])).toBe(fingerprint(['a', 'b']));
    expect(fingerprint(['ab', ''])).not.toBe(fingerprint(['a', 'b']));
  });
});

describe('chargeBudget', () => {
  test('heal stops at maxHeal', () => {
    for (let i = 0; i < 3; i++) expect(chargeBudget(db, id, 'heal', `f${i}`, b).ok).toBe(true);
    expect(chargeBudget(db, id, 'heal', 'f9', b)).toEqual({
      ok: false,
      reason: 'budget exhausted: heal',
    });
    expect(getAttempts(db, id, 'heal').count).toBe(3);
  });

  test('a clean resolve on a new fingerprint is free', () => {
    for (const fp of ['a', 'b', 'c', 'd'])
      expect(chargeBudget(db, id, 'resolve', fp, b).ok).toBe(true);
    expect(getAttempts(db, id, 'resolve').count).toBe(0);
  });

  test('free resolves stop at maxResolveTotal', () => {
    for (let i = 0; i < 6; i++) expect(chargeBudget(db, id, 'resolve', `f${i}`, b).ok).toBe(true);
    expect(chargeBudget(db, id, 'resolve', 'f9', b)).toEqual({
      ok: false,
      reason: 'budget exhausted: resolve-total',
    });
    expect(getAttempts(db, id, 'resolve_total').count).toBe(6);
  });

  test('a free resolve charges only resolve_total and refunds exactly that', () => {
    const r = chargeBudget(db, id, 'resolve', 'a', b);
    expect(r).toEqual({ ok: true, charged: ['resolve_total'] });
    chargeResolveConflict(db, id, b);
    refundCharge(db, id, 'resolve_total');
    expect(getAttempts(db, id, 'resolve_total').count).toBe(0);
    expect(getAttempts(db, id, 'resolve').count).toBe(1);
  });

  test('a repeated resolve fingerprint charges both keys', () => {
    chargeBudget(db, id, 'resolve', 'a', b);
    expect(chargeBudget(db, id, 'resolve', 'a', b)).toEqual({
      ok: true,
      charged: ['resolve', 'resolve_total'],
    });
  });

  test('repeated resolve fingerprints stop at maxResolve and write nothing', () => {
    for (let i = 0; i < 3; i++) expect(chargeBudget(db, id, 'resolve', 'a', b).ok).toBe(true);
    expect(chargeBudget(db, id, 'resolve', 'a', b)).toEqual({
      ok: false,
      reason: 'budget exhausted: resolve',
    });
    expect(getAttempts(db, id, 'resolve').count).toBe(2);
    expect(getAttempts(db, id, 'resolve_total').count).toBe(3);
  });

  test('review repeats only count on the same fingerprint', () => {
    expect(chargeBudget(db, id, 'review', 'h1', b)).toEqual({ ok: true, charged: ['review'] });
    expect(getAttempts(db, id, 'review').count).toBe(1);
    expect(chargeBudget(db, id, 'review', 'h1', b).ok).toBe(true);
    expect(getAttempts(db, id, 'review').count).toBe(2);
    expect(chargeBudget(db, id, 'review', 'h1', b)).toEqual({
      ok: false,
      reason: 'budget exhausted: review',
    });
    expect(chargeBudget(db, id, 'review', 'h2', b).ok).toBe(true);
    expect(getAttempts(db, id, 'review').count).toBe(1);
  });

  test('a review charged on a new fingerprint refunds to 0', () => {
    chargeBudget(db, id, 'review', 'h1', b);
    refundCharge(db, id, 'review');
    expect(getAttempts(db, id, 'review').count).toBe(0);
  });

  test('resume ignores the fingerprint and stops at maxResume', () => {
    expect(chargeBudget(db, id, 'resume', '', b)).toEqual({ ok: true, charged: ['resume'] });
    expect(chargeBudget(db, id, 'resume', '', b).ok).toBe(true);
    expect(chargeBudget(db, id, 'resume', '', b)).toEqual({
      ok: false,
      reason: 'budget exhausted: resume',
    });
  });
});

describe('other charges', () => {
  test('resolve conflicts are charged', () => {
    expect(chargeResolveConflict(db, id, b)).toBe(true);
    expect(chargeResolveConflict(db, id, b)).toBe(true);
    expect(chargeResolveConflict(db, id, b)).toBe(false);
  });

  test('no-change stops after maxNoChange', () => {
    expect(chargeNoChange(db, id, b)).toBe(true);
    expect(chargeNoChange(db, id, b)).toBe(false);
  });

  test('rate-limit requeues stop after 3', () => {
    expect(RATE_LIMIT_REQUEUE_MAX).toBe(3);
    for (let i = 0; i < 3; i++) expect(chargeRateLimitRequeue(db, id)).toBe(true);
    expect(chargeRateLimitRequeue(db, id)).toBe(false);
  });

  test('refundCharge(null) is a no-op and refunds floor at 0', () => {
    chargeBudget(db, id, 'heal', 'x', b);
    refundCharge(db, id, null);
    expect(getAttempts(db, id, 'heal').count).toBe(1);
    refundCharge(db, id, 'heal,heal,resolve');
    expect(getAttempts(db, id, 'heal').count).toBe(0);
    expect(getAttempts(db, id, 'resolve').count).toBe(0);
  });
});
