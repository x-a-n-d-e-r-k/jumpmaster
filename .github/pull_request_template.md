## What and why

## Checklist

- [ ] `npm test`, `npm run typecheck` and `npx biome check .` pass
- [ ] new dependencies: exact pin, version and release date ≥14 days old recorded in the commit
- [ ] images, actions and downloads are pinned (digest, full commit SHA, checksum); `scripts/pins.test.ts` passes
- [ ] no secret value in logs, argv, URLs, image layers, labels, compose files or forge bodies
