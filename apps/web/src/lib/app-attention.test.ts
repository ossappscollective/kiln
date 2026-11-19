import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type AttentionInput,
  attentionItems,
  ciFailed,
  newestBuild,
  stagedUnpushedCount,
} from './app-attention.ts';
import type { AppBuild, PlanSummary } from './types.ts';

const build = (
  n: string,
  uploadedAt: number,
  conclusion: string | null,
  status = 'completed',
): AppBuild =>
  ({
    platform: 'ios',
    buildNumber: n,
    version: '1.0.0',
    tracks: [],
    status: null,
    rawState: '',
    uploadedAt,
    syncedAt: 1,
    linkState: conclusion === null ? 'unlinked' : 'linked',
    link:
      conclusion === null
        ? null
        : ({
            run: { id: 'r', workflow: 'w', title: null, status, conclusion },
          } as AppBuild['link']),
    diagnostic: null,
  }) as AppBuild;

const plan = (
  over: Partial<PlanSummary> & { overdue?: boolean; dueSoon?: boolean } = {},
): PlanSummary =>
  ({
    id: 'p1',
    version: '2.0.0',
    platform: null,
    targetDate: '2026-01-01',
    blocked: false,
    blockedReason: null,
    released: false,
    due: { overdue: over.overdue ?? false, dueSoon: over.dueSoon ?? false, daysLeft: null },
    ...over,
  }) as PlanSummary;

const empty = (apps: AttentionInput['apps']): AttentionInput => ({
  apps,
  scope: null,
  newReviews: {},
  builds: {},
  driftLocales: {},
  stagedUnpushed: {},
  plans: {},
});

const ios = { id: 'a1', platform: 'ios' as const, lastSyncError: null };
const droid = { id: 'a2', platform: 'android' as const, lastSyncError: null };

describe('attention items', () => {
  it('has no item when there is nothing to show', () => {
    assert.deepEqual(attentionItems(empty([ios, droid])), []);
  });

  it('picks the newest build and sees a failed run', () => {
    const builds = [build('1', 10, 'success'), build('2', 20, 'failure'), build('3', 5, null)];
    assert.equal(newestBuild(builds)?.buildNumber, '2');
    assert.equal(ciFailed(builds[1] as AppBuild), true);
    assert.equal(ciFailed(builds[0] as AppBuild), false);
    assert.equal(ciFailed(build('4', 1, 'failure', 'in_progress')), false);
  });

  it('reports a failed newest build, not an older failure', () => {
    const input = {
      ...empty([ios]),
      builds: { a1: [build('1', 10, 'failure'), build('2', 20, 'success')] },
    };
    assert.deepEqual(attentionItems(input), []);
    const bad = {
      ...empty([ios]),
      builds: { a1: [build('1', 10, 'success'), build('2', 20, 'timed_out')] },
    };
    const items = attentionItems(bad);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.text, 'CI failed for build 2');
    assert.equal(items[0]?.href, '#/portfolio/a1/builds');
  });

  it('names the platform only when two are in scope, and orders by severity', () => {
    const input: AttentionInput = {
      ...empty([ios, droid]),
      newReviews: { a1: 3 },
      driftLocales: { a2: 2 },
      stagedUnpushed: { a1: 1 },
      plans: { a1: [plan({ overdue: true })] },
    };
    const items = attentionItems(input);
    assert.deepEqual(
      items.map((i) => i.tone),
      ['bad', 'warn', 'warn', 'info'],
    );
    assert.equal(items[0]?.text, 'iOS: Version 2.0.0 is overdue');
    assert.equal(items[1]?.text, 'iOS: 1 staged change is not pushed to the store draft');
    assert.equal(items[2]?.text, 'Android: 2 locales differ from the store or the repository');
    assert.equal(items[3]?.text, 'iOS: 3 new reviews to triage');
    assert.equal(
      attentionItems({ ...empty([ios]), newReviews: { a1: 1 } })[0]?.text,
      '1 new review to triage',
    );
  });

  it('skips released plans and plans of the other platform', () => {
    const input = {
      ...empty([ios]),
      plans: {
        a1: [plan({ overdue: true, released: true }), plan({ overdue: true, platform: 'android' })],
      },
    };
    assert.deepEqual(attentionItems(input), []);
  });

  it('reports a blocked plan with its reason and a failed sync', () => {
    const input = {
      ...empty([{ ...ios, lastSyncError: ' Credential rejected. ' }]),
      plans: { a1: [plan({ blocked: true, blockedReason: 'Legal review' })] },
    };
    const items = attentionItems(input);
    assert.equal(items[0]?.detail, 'Credential rejected.');
    assert.equal(items[0]?.href, null);
    assert.equal(items[1]?.detail, 'Legal review');
  });

  it('keeps the platform scope in the links', () => {
    const input = { ...empty([ios]), scope: 'ios' as const, driftLocales: { a1: 1 } };
    assert.equal(attentionItems(input)[0]?.href, '#/portfolio/a1/listing?platform=ios');
  });

  it('counts staged items that are not pushed yet', () => {
    assert.equal(stagedUnpushedCount(null), 0);
    const view = {
      text: [
        { pushed: false, status: 'changed' },
        { pushed: true, status: 'changed' },
        { pushed: false, status: 'unchanged' },
        { pushed: false, status: 'invalid' },
      ],
      assets: [{ pushed: false }, { pushed: true }],
    } as unknown as Parameters<typeof stagedUnpushedCount>[0];
    assert.equal(stagedUnpushedCount(view), 3);
  });
});

describe('a pushed draft that is ready to submit', () => {
  it('is an item with the submit control of that app, and no link', () => {
    const items = attentionItems({ ...empty([ios, droid]), submitReady: { a2: true, a1: false } });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.id, 'a2:submit');
    assert.equal(items[0]?.submitAppId, 'a2');
    assert.equal(items[0]?.href, null);
    assert.equal(items[0]?.text, 'Android: Draft pushed — ready to submit?');
  });

  it('is not drawn without the data (a role below admin never fills it)', () => {
    assert.deepEqual(attentionItems(empty([ios])), []);
    assert.deepEqual(attentionItems({ ...empty([ios]), submitReady: {} }), []);
  });
});
