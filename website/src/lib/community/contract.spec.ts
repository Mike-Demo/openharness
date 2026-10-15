// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as backend from '../../../../backend/src/lib/communityContract';
import { communityCategories, communityEngines, communityHarnesses, communityLimits, missingMarker } from './contract';
import { starterHarnesses } from './starters';

describe('the Hub contract', () => {
  it('matches what the backend accepts', () => {
    expect(Object.fromEntries(Object.entries(communityHarnesses).map(([id, { marker }]) => [id, marker]))).toEqual(backend.communityHarnessMarkers);
    expect(communityCategories).toEqual(backend.communityCategories);
    expect(communityEngines).toEqual(backend.communityEngines);
    for (const key of ['files', 'fileChars', 'snapshotBytes', 'turns', 'turnChars'] as const)
      expect(communityLimits[key], key).toBe(backend.communityLimits[key]);
  });
  it('lists the same starters the backend serves', async () => {
    const { communityStarters } = await import('../../../../backend/src/lib/communityAccess');
    // In order: a popular feed keeps the backend's order among starters with as many likes.
    expect(starterHarnesses.map(item => item.id)).toEqual([...communityStarters]);
  });
  it('offers the report reasons the backend accepts', async () => {
    const { readFileSync } = await import('node:fs');
    const { reportReasons } = await import('./reports');
    // Read, not imported: the backend module brings its environment and database client with it.
    const source = readFileSync(new URL('../../../../backend/src/lib/communityReports.ts', import.meta.url), 'utf8');
    const listed = source.match(/communityReportReasons = \[([^\]]+)\]/)?.[1].match(/'([a-z_]+)'/g)?.map(word => word.slice(1, -1));
    expect(reportReasons.map(([reason]) => reason)).toEqual(listed);
  });
  it('names a missing harness source', () => {
    expect(missingMarker('autonomous/blender', ['index.html'])).toBe('scenes/hello.py');
    expect(missingMarker('autonomous/blender', ['index.html', 'scenes/hello.py'])).toBeNull();
    expect(missingMarker(undefined, [])).toBeNull();
  });
});
