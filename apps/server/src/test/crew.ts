import { type DropZoneConfig, DropZoneObject } from '../config.js';
import { refreshGoals } from '../goals.js';
import { makeZone, type ZoneWorld, zoneWorld } from './fixtures.js';
import { t0 } from './helpers.js';

export const GOAL = `# Goals

## Lighthouse

Every endpoint is documented, LIGHTHOUSE-TEXT.

## Objectives

### Document every endpoint

Start with the public API.

### Ship the CLI
`;

/** An issue body in the agent-ready format. */
export const ISSUE_BODY = `## Context

The API has no docs.

## Acceptance criteria

- [ ] every endpoint has a page

## Required tests

- a test that lists the pages
`;

export const crewOn = { ...makeZone().crew, enabled: true };

/**
 * A zone's crew settings as the real zone schema parses them from `crew` in a config file, so a
 * key the file leaves out takes the schema's default rather than a fixture's value.
 */
export function parsedCrew(crew: Record<string, unknown> = {}): DropZoneConfig['crew'] {
  return DropZoneObject.parse({
    id: 'main',
    repo: 'octo/demo',
    gates: [{ name: 'test', run: 'npm test' }],
    image: 'img',
    crew: { enabled: true, ...crew },
  }).crew;
}

/** A zone world with the crew enabled and GOAL.md read into the ladder. */
export async function crewWorld(
  o: Partial<Parameters<typeof zoneWorld>[0]> = {},
): Promise<ZoneWorld> {
  const w = zoneWorld({ crew: crewOn, ...o });
  w.f.state.files.set('main:GOAL.md', GOAL);
  await refreshGoals(w.db, w.f.author, w.zone, 'main', t0);
  return w;
}
