import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * What the screens wire to the shared publishing store, checked on their source (no DOM runs here): the top bar button, the status banner
 * of the Next step card and the buttons it turns off, and the failure under each place that shows a publish. The behaviour behind them
 * (the store, the loader, the target of the panel, the report) is tested in publishing.test.ts and publish-failure.test.ts.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the top bar button shows a running publish: a spinner, "Publishing…", aria-busy, a polite live region, and opens the panel on it', () => {
  const btn = read('../components/app/PendingCartButton.svelte');
  assert.match(btn, /publishingStore\.ids\(workspaceId\)/);
  assert.match(btn, /aria-busy=\{busy\}/);
  assert.match(btn, /aria-live="polite"/);
  assert.match(btn, /<Spinner size=\{16\} label="" \/>/);
  assert.match(btn, /publish:publishing\.chip/);
  assert.match(btn, /openPublishingPanel\(id\)/);
  assert.match(btn, /const shown = \$derived\(cartButton\.visible \|\| busy\)/);
  const shell = read('../components/Shell.svelte');
  assert.match(shell, /<PendingCartButton tintStyle=\{appTintStyle\} \{workspaceId\} \/>/);
});

test('the Next step card has the status banner with "Show pending changes" and turns its buttons off while its app publishes', () => {
  const card = read('../components/app/NextStep.svelte');
  assert.match(card, /<PublishingStatus/);
  assert.match(card, /publish:publishing\.showPending/);
  assert.match(card, /openPublishingPanel\(p\.appId, scope\)/);
  // The primary button, the row buttons and the Review and publish link are each guarded.
  assert.match(card, /off\(primaryAppId\)/);
  assert.match(card, /off\(r\.appId\)/);
  assert.match(card, /publish:publishing\.pendingOff/);
  assert.doesNotMatch(card, /PublishingNote/, 'the small grey sentence is replaced by the banner');
});

test('the status row takes the request to be shown: it scrolls into view and takes focus once', () => {
  const row = read('../components/publish/PublishingStatus.svelte');
  assert.match(row, /publishingFocus\.requested !== appId/);
  assert.match(row, /scrollIntoView\(\{ block: 'start'/);
  assert.match(row, /publishingFocus\.done\(id\)/);
  for (const file of [
    '../components/app/PendingCartDrawer.svelte',
    '../components/publish/PendingChanges.svelte',
    '../components/pending/WorkspacePending.svelte',
  ])
    assert.match(read(file), /<PublishingStatus[^>]*appId=/, file);
});

test('the reason of a failed publish shows in the panel, the drawer, the Pending page and the dialog', () => {
  for (const file of [
    '../components/app/PendingCartDrawer.svelte',
    '../components/publish/PendingChanges.svelte',
    '../components/pending/WorkspacePending.svelte',
  ]) {
    const source = read(file);
    assert.match(source, /<PublishFailure /, file);
    assert.match(source, /publishingStore\.dismissFailure\(api, workspaceId, /, file);
  }
  const dialog = read('../components/publish/PublishDialog.svelte');
  assert.match(dialog, /<PublishFailureDetail run=\{result\.lastPublish\}/);
  const failure = read('../components/publish/PublishFailure.svelte');
  assert.match(failure, /CopyButton/);
  assert.match(failure, /publish:failure\.showMore/);
});
