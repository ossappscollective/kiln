import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * What the screens wire to the shared publishing store, checked on their source (no DOM runs here): the top bar button, the status banner
 * of the Next step card and the buttons it turns off, and the failure under each place that shows a publish. The behaviour behind them
 * (the store, the loader, the target of the panel, the report) is tested in publishing.test.ts and publish-failure.test.ts.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the top bar button shows what the state model says: a running publish (spinner, "Publishing…", aria-busy, polite live region), a failed one, and opens the panel on it', () => {
  const btn = read('../components/app/PendingCartButton.svelte');
  assert.match(btn, /appStateStore\.topBar\(workspaceId\)/);
  assert.doesNotMatch(btn, /publishingStore/, 'the button reads the model, not the claims store');
  assert.match(btn, /aria-busy=\{busy\}/);
  assert.match(btn, /aria-live="polite"/);
  assert.match(btn, /<Spinner size=\{16\} label="" \/>/);
  assert.match(btn, /publish:publishing\.chip/);
  assert.match(btn, /openPendingPanel\('publishing', badge\.appId\)/);
  assert.match(btn, /openPendingPanel\('failed', badge\.appId\)/);
  assert.match(btn, /state:topBar\.failed/);
  const shell = read('../components/Shell.svelte');
  assert.match(shell, /<PendingCartButton tintStyle=\{appTintStyle\} \{workspaceId\} \/>/);
});

test("the Next step card draws the headline, the reason and the offers of the state model, and turns its buttons off with the model's reason", () => {
  const card = read('../components/app/NextStep.svelte');
  assert.match(card, /appStateStore\.of\(/);
  assert.match(card, /appState\.headline/);
  assert.match(card, /appState\.reason/);
  assert.match(card, /disabled=\{!offer\.enabled\}/);
  assert.match(card, /offer\.disabledReason/);
  assert.match(card, /openPendingPanel\(kind, offer\.appId/);
  assert.doesNotMatch(
    card,
    /publishingStore|chooseNextStep|nextStepTrains/,
    'the card decides nothing by itself',
  );
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
    assert.match(source, /appStateStore\.dismissFailure\(api, workspaceId, /, file);
    assert.match(source, /<FailureAnchor /, `${file}: the failure takes the request to be shown`);
  }
  const dialog = read('../components/publish/PublishDialog.svelte');
  assert.match(dialog, /<PublishFailureDetail run=\{result\.lastPublish\}/);
  const failure = read('../components/publish/PublishFailure.svelte');
  assert.match(failure, /CopyButton/);
  assert.match(failure, /publish:failure\.showMore/);
});
