import { describe, expect, test } from 'vitest';
import { jobNames, MATRIX_AND_REUSABLE_NOTE, runsOnPullRequest } from './workflows.js';

// Shapes taken from real workflows: a plain job, a `name:` override (quoted and with a comment),
// a matrix job, a reusable workflow call, keys that look like jobs at the wrong depth, comments
// and blank lines, a second top-level block after `jobs:`, and four-space indentation.
const CI = `name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  # the main check
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
        name: not the job name
  lint:
    name: "Lint and format" # what the Checks tab shows
    runs-on: ubuntu-latest
    steps:
      - name: also not the job name
        run: npm run lint

  build:
    name: build \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    runs-on: \${{ matrix.os }}
    steps:
      - run: make
  call-shared:
    uses: octo/shared/.github/workflows/check.yml@0123456789abcdef0123456789abcdef01234567
'quoted-id':
  not: a job
`;

const FOUR = `on: [push, pull_request]
jobs:
    unit:
        name: 'Unit tests'
        runs-on: ubuntu-latest
    e2e:
        runs-on: ubuntu-latest
`;

describe('jobNames', () => {
  test('jobNames reads job ids and name overrides from real workflow shapes, ignores a matrix expansion, and the step names the caller / inner form', () => {
    // A step's `name:` is deeper than the job's and never replaces the id.
    expect(jobNames(CI)).toEqual(['test', 'Lint and format', 'build', 'call-shared']);
    expect(jobNames(FOUR)).toEqual(['Unit tests', 'e2e']);
    // A name built from an expression is the matrix's: the job id stands, and the step says to
    // check the expanded names (`build (ubuntu-latest)`) and a reusable workflow's `caller / inner`.
    expect(MATRIX_AND_REUSABLE_NOTE).toContain('caller / inner');
    expect(MATRIX_AND_REUSABLE_NOTE).toContain('Checks tab');
    expect(jobNames('name: no jobs\non: push\n')).toEqual([]);
    expect(jobNames('jobs: {}\n')).toEqual([]);
    expect(jobNames('')).toEqual([]);
  });

  test('runsOnPullRequest reads the top-level on: in its three forms, and not pull_request_target alone', () => {
    expect(runsOnPullRequest(CI)).toBe(true);
    expect(runsOnPullRequest(FOUR)).toBe(true);
    expect(runsOnPullRequest('on: pull_request\njobs:\n  a:\n    runs-on: x\n')).toBe(true);
    expect(runsOnPullRequest('"on":\n  - pull_request\n')).toBe(true);
    expect(runsOnPullRequest('on:\n  push:\n    branches: [main]\njobs:\n  pull_request:\n')).toBe(
      false,
    );
    expect(runsOnPullRequest('on: [pull_request_target]\n')).toBe(false);
    expect(runsOnPullRequest('on:\n  release:\n    types: [published]\n')).toBe(false);
  });
});
