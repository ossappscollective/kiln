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

test('the status row says what a long step does and when the server went quiet, and offers the way out of a ghost: check, and end only when the server allows', () => {
  const row = read('../components/publish/PublishingStatus.svelte');
  assert.match(row, /progressText\(publishing\)/);
  assert.match(row, /data-testid="publishing-progress"/);
  assert.match(row, /quietText\(publishing, now\)/);
  assert.match(row, /data-testid="publishing-quiet"/);
  assert.match(row, /looksStuck\(publishing, now\)/);
  // "Still running? Check status" reads the claim again; it stops nothing.
  assert.match(row, /appStateStore\.recheckPublishing\(workspaceId\)/);
  assert.match(row, /publish:publishing\.check'/);
  // "Mark as interrupted" only for a person who may publish AND when the server says the claim can be ended.
  assert.match(row, /canInterrupt && publishing\.interruptible === true/);
  assert.match(row, /\{#if mayEnd\}<Button[^>]*onclick=\{end\}/);
  assert.match(row, /appStateStore\.interruptPublish\(workspaceId, appId\)/);
  assert.match(row, /publish:publishing\.interruptStill/);
  // The way out is only for the server's claim: this browser's own mark has no heartbeat.
  assert.match(row, /publishing\.heartbeatAt !== undefined && workspaceId !== undefined/);
  for (const file of [
    '../components/app/PendingCartDrawer.svelte',
    '../components/publish/PendingChanges.svelte',
    '../components/pending/WorkspacePending.svelte',
  ])
    assert.match(read(file), /<PublishingStatus[^>]*\{workspaceId\}[^>]*canInterrupt/, file);
  for (const file of [
    '../components/publish/PendingChanges.svelte',
    '../components/pending/WorkspacePending.svelte',
  ])
    assert.match(read(file), /canInterrupt=\{canPublishBatch\(role\)\}/, file);
});

test('the store only ends a claim through the server: its answer decides, and every answer is read again', () => {
  const store = read('./publishing-store.svelte.ts');
  assert.match(store, /api\.interruptPublish\(workspaceId, appId\)/);
  assert.match(store, /e\.status === 409 && e\.code === 'still_running'/);
  assert.match(store, /await loader\.refresh\(workspaceId\);\n {4}return answer;/);
  const api = read('./api.ts');
  assert.match(api, /publish\/interrupt`/);
});

test('the dialog stops waiting for its request when the server ended the publish (restart, lost request), and keeps the answer of a request that does come', () => {
  const dialog = read('../components/publish/PublishDialog.svelte');
  assert.match(
    dialog,
    /endedByServer\(publishingStore\.failureOf\(workspaceId, app\.id\), failureBefore\)/,
  );
  assert.match(dialog, /failureBefore = publishingStore\.failureOf\(space, appId\)\?\.id/);
  assert.match(dialog, /t\('app:pending\.failed\.interrupted'\)/);
  // A late answer is not ours any more (the sequence moved on).
  assert.match(
    dialog,
    /if \(!endedHere\) return;\n {4}\/\/ The request is not waited for any more[^\n]*\n {4}seq\+\+;/,
  );
});

test('"Fix the blockers, then submit": the card and the top bar say it, the card opens the submit checklist, and SubmitReady answers the request once it can act', () => {
  const card = read('../components/app/NextStep.svelte');
  assert.match(
    card,
    /offer\.action === 'fix_blockers' && offer\.appId !== null\) openSubmitChecklist\(offer\.appId, stateScope\)/,
  );
  const btn = read('../components/app/PendingCartButton.svelte');
  assert.match(btn, /state:topBar\.blocked/);
  const panel = read('./app-state/panel.svelte.ts');
  assert.match(panel, /export function openSubmitChecklist/);
  assert.match(
    panel,
    /if \(!submitFocus\.isDrawn\(appId\)\) location\.hash = appAddress\(appId, 'listing', scope\)/,
  );
  const ready = read('../components/listing/SubmitReady.svelte');
  assert.match(ready, /\$effect\(\(\) => submitFocus\.mount\(app\.id\)\)/);
  assert.match(ready, /submitFocus\.requested !== app\.id/);
  assert.match(
    ready,
    /!verdict\.enabled\) return;\n {4}untrack\(\(\) => \{\n {6}submitFocus\.done\(app\.id\);\n {6}void startPreview\(\);/,
  );
  // The failure shown on every page lists the blockers with how to fix them.
  const failure = read('../components/publish/PublishFailure.svelte');
  assert.match(failure, /data-testid="publish-blockers"/);
  assert.match(failure, /line\.blockers/);
});

test('a blocker about the App Review Information offers "Copy review information" in the submit checklist and the publish plan, from one component that follows the model', () => {
  const copy = read('../components/publish/ReviewInfoCopy.svelte');
  // One button, two steps: a masked preview (a store read), then the write with the preview's hash inside `confirmed(...)`.
  assert.match(copy, /previewStoreReviewInformation\(/);
  assert.match(copy, /confirmed\(/);
  assert.match(copy, /copyStoreReviewInformation\(/);
  assert.match(copy, /appStateStore\.verdict\(.*'create_version'\)/s);
  assert.match(copy, /summaryText\(/, 'the screen shows the masked line, never a value');
  for (const path of [
    '../components/publish/SubmitPreviewBody.svelte',
    '../components/publish/SubmitReadiness.svelte',
  ]) {
    const list = read(path);
    assert.match(list, /<ReviewInfoCopy /);
    assert.match(list, /isReviewCode\(/);
  }
  assert.match(read('../components/listing/SubmitReady.svelte'), /provideReviewRepair\(/);
  assert.match(read('../components/publish/PublishDialog.svelte'), /provideReviewRepair\(/);
  // The readiness rules are the server's: the lists only draw them, and neither computes whether the contact is missing.
  for (const path of [
    '../components/publish/SubmitPreviewBody.svelte',
    '../components/publish/SubmitReadiness.svelte',
    '../components/publish/ReviewInfoCopy.svelte',
  ])
    assert.doesNotMatch(
      read(path),
      /contactFirstName|contactPhone|contactEmail|demoAccountPassword/,
    );
});

test('the create-version form says what is carried over from the previous version, masked, before and after', () => {
  const form = read('../components/release/stepper/CreateVersion.svelte');
  assert.match(form, /carryLine\(preview\.reviewInformation, 'preview'\)/);
  assert.match(form, /carryLine\(done\.result\.reviewInformation, 'result'\)/);
  assert.match(form, /data-testid="create-version-review-info"/);
});

test('an added language has a one-click unstage for this app, through the one API call and the staged store', () => {
  const list = read('../components/publish/SubmitReadiness.svelte');
  assert.match(list, /api\.unstageLocale\(workspaceId, appId, locale\)/);
  assert.match(list, /stagedStore\.set\(done\.staged\)/);
  assert.match(list, /data-testid="submit-readiness-unstage"/);
  assert.match(read('../components/publish/PublishSummary.svelte'), /<SubmitReadiness [^>]*appId=\{summary\.appId\}/);
  const api = read('./api.ts');
  assert.match(api, /unstageLocale: \(workspaceId: string, appId: string, locale: string\)[\s\S]*?stagedChanged\(appId, 'unstage'\)/);
  // The proposal never stages a new language the person did not tick.
  assert.match(read('../components/release/stepper/AssetProposalCard.svelte'), /addLanguages/);
});
