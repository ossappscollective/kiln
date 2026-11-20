import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AppSummary, CiWorkflow, RepositorySummary } from '../types.ts';
import {
  DISPATCH_DIALOG_PROPS,
  dispatchLinkableApps,
  dispatchPreselection,
  dispatchTarget,
} from './dispatch-target.ts';

const repository = { id: 'r1', defaultBranch: 'main' } as RepositorySummary;
const workflow = {
  id: 1,
  name: 'Build',
  path: '.github/workflows/build.yml',
} as unknown as CiWorkflow;
const app = (id: string, platform: 'ios' | 'android', repositoryId: string | null) =>
  ({ id, platform, repositoryId, name: id, identifier: id }) as unknown as AppSummary;
const apps = [app('a', 'ios', 'r1'), app('b', 'android', 'r1'), app('c', 'ios', 'r2')];

test('every entry point builds the same target shape', () => {
  const fromRepositoryPage = dispatchTarget({ repository, workflow });
  const fromWorkflowsPage = dispatchTarget({ repository, workflow, platforms: ['ios'] });
  assert.deepEqual(
    Object.keys(fromRepositoryPage).sort(),
    Object.keys({ ...fromWorkflowsPage }).sort(),
  );
  assert.equal(fromRepositoryPage.appId, '');
});

test('the apps to pick from are all the apps of the repository, so several can be chosen anywhere', () => {
  assert.deepEqual(
    dispatchLinkableApps(apps, 'r1').map((a) => a.id),
    ['a', 'b'],
  );
});

test('preselection: the named app, the one platform match, or none (none means every app of the repository)', () => {
  assert.deepEqual(
    dispatchPreselection(apps, dispatchTarget({ repository, workflow, appId: 'b' })),
    ['b'],
  );
  assert.deepEqual(
    dispatchPreselection(apps, dispatchTarget({ repository, workflow, platforms: ['ios'] })),
    ['a'],
  );
  assert.deepEqual(dispatchPreselection(apps, dispatchTarget({ repository, workflow })), []);
  assert.deepEqual(
    dispatchPreselection(apps, dispatchTarget({ repository, workflow, appId: 'c' })),
    [],
  );
});

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? svelteFiles(path)
      : path.endsWith('.svelte')
        ? [path]
        : [];
  });
}

test('every <DispatchDialog> passes exactly the same props', () => {
  const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'components');
  let found = 0;
  for (const file of svelteFiles(root)) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<DispatchDialog\s([\s\S]*?)\/>/g)) {
      found += 1;
      const props = (match[1] ?? '')
        .split('\n')
        .map((line) => /^\s*(?:\{(\w+)\}|(\w+)=)/.exec(line))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => m[1] ?? m[2] ?? '')
        .sort();
      assert.deepEqual(props, [...DISPATCH_DIALOG_PROPS].sort(), file);
    }
  }
  assert.ok(found >= 4, 'the four entry points are found');
});
