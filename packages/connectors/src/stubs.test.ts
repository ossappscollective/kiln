import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalCloneRepoConnector, NotImplementedError } from './index.ts';

// The store connectors have their own contract tests (appstoreconnect.test.ts,
// googleplay.test.ts); the GitHub connector has github.test.ts.

test('the local clone stub fails loudly on every RepoConnector method', () => {
  const local = new LocalCloneRepoConnector('/tmp/clone');
  assert.equal(local.kind, 'local');
  assert.throws(() => local.listFiles(), NotImplementedError);
  assert.throws(() => local.readFile('a'), NotImplementedError);
  assert.throws(
    () =>
      local.propose(
        {
          id: 'c',
          workspaceId: 'w',
          summary: '',
          target: 'repo',
          status: 'draft',
          createdBy: { type: 'user', id: 'u' },
          files: [],
        },
        { branch: 'b', title: 't' },
      ),
    NotImplementedError,
  );
  assert.throws(() => local.dispatchWorkflow('w', 'main'), NotImplementedError);
  assert.throws(() => local.listWorkflowRuns(), NotImplementedError);
});
