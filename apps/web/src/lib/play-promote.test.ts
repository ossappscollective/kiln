import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultTarget,
  promoteFromHash,
  promoteHref,
  promoteNote,
  promoteOption,
  promoteOptions,
  withoutPromote,
} from './play-promote.ts';
import { stepFromHash } from './release-stepper.ts';
import type { ReleaseSummary } from './types.ts';

const release = (over: Partial<ReleaseSummary> = {}): ReleaseSummary => ({
  id: 'r1',
  appId: 'app1',
  platform: 'android',
  version: '3.4.1',
  track: 'internal',
  build: null,
  status: 'live',
  rawState: 'completed',
  rolloutFraction: null,
  versionCodes: ['241'],
  storeUpdatedAt: null,
  syncedAt: 0,
  ...over,
});

test('a live release in a track that is not production can be promoted, to production by default', () => {
  for (const track of ['internal', 'alpha', 'beta', 'my-testers']) {
    const option = promoteOption(release({ track }));
    assert.ok(option, track);
    assert.deepEqual([option.from, option.to, option.codes], [track, 'production', ['241']]);
    assert.equal(option.label, 'Promote to production');
  }
  assert.equal(defaultTarget('internal'), 'production');
  assert.equal(promoteOption(release({ track: 'beta' }))?.fromLabel, 'open testing (beta)');
  assert.equal(
    promoteOption(release({ status: 'rolling_out', rolloutFraction: 0.5 }))?.from,
    'internal',
  );
});

test('nothing to promote: production, iOS, a draft, a halted release, no codes, or already live in production', () => {
  assert.equal(promoteOption(release({ track: 'production' })), null);
  assert.equal(promoteOption(release({ track: 'Production' })), null);
  assert.equal(promoteOption(release({ platform: 'ios', track: null })), null);
  assert.equal(promoteOption(release({ status: 'draft' })), null);
  assert.equal(promoteOption(release({ status: 'halted' })), null);
  assert.equal(promoteOption(release({ status: null })), null);
  assert.equal(promoteOption(release({ versionCodes: [] })), null);
  assert.equal(promoteOption(release({ versionCodes: null })), null);
  const live = release({ id: 'r2', track: 'production', versionCodes: ['241', '242'] });
  assert.equal(promoteOption(release(), [live]), null);
  // A production draft, or another app's release, does not count as promoted.
  assert.ok(promoteOption(release(), [{ ...live, status: 'draft' }]));
  assert.ok(promoteOption(release(), [{ ...live, appId: 'other' }]));
  assert.ok(promoteOption(release(), [{ ...live, versionCodes: ['100'] }]));
});

test('options are the newest codes first', () => {
  const options = promoteOptions([
    release({ id: 'a', versionCodes: ['200'], version: '3.3' }),
    release({ id: 'b', track: 'beta', versionCodes: ['241'], version: '3.4.1' }),
    release({ id: 'c', track: 'production', versionCodes: ['100'] }),
  ]);
  assert.deepEqual(
    options.map((o) => o.version),
    ['3.4.1', '3.3'],
  );
});

test('the address opens the first step with the track, the codes and the target, and reads back', () => {
  const option = promoteOption(release({ versionCodes: ['240', '241'] }));
  assert.ok(option);
  const href = promoteHref(option);
  assert.match(href, /^#\/portfolio\/app1\/releases\?platform=android&/);
  assert.equal(stepFromHash(href), 'build');
  assert.deepEqual(promoteFromHash(href), {
    from: 'internal',
    to: 'production',
    codes: ['240', '241'],
  });
  assert.equal(promoteFromHash('#/portfolio/app1/releases?step=build'), null);
});

test('an address that is not a promotion is ignored', () => {
  assert.equal(promoteFromHash('#/x?from=internal&codes='), null);
  assert.equal(promoteFromHash('#/x?from=bad track&codes=1'), null);
  assert.equal(promoteFromHash('#/x?from=internal&codes=1,x'), null);
  assert.equal(
    promoteFromHash(
      '#/x?from=internal&codes=' + Array.from({ length: 21 }, (_, i) => i + 1).join(','),
    ),
    null,
  );
  assert.deepEqual(promoteFromHash('#/x?from=beta&to=%3Cb%3E&codes=7'), {
    from: 'beta',
    to: 'production',
    codes: ['7'],
  });
  assert.match(
    promoteNote({ from: 'internal', to: 'production', codes: ['241'] }),
    /Promoting from internal testing to production: version code 241 is selected/,
  );
});

test('closing the steps drops the promotion but keeps the rest of the address', () => {
  assert.equal(
    withoutPromote(
      '#/portfolio/app1/releases?platform=android&step=build&from=internal&to=production&codes=241',
    ),
    '#/portfolio/app1/releases?platform=android&step=build',
  );
  assert.equal(
    withoutPromote('#/portfolio/app1/releases?from=beta&codes=1'),
    '#/portfolio/app1/releases',
  );
  assert.equal(withoutPromote('#/portfolio/app1/releases'), '#/portfolio/app1/releases');
});
