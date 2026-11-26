import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

/**
 * What the screens wire for the combined step (Google Play: push and submit for review in one step), checked on their source (no DOM
 * runs here). The words and the pure rules are tested in pending.test.ts, publish-failure.test.ts and publish-summary.test.ts.
 */
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('the failure block offers "Push and submit for review in one step" only with a handler, and "Make the change in Play Console" as a link', () => {
  const failure = read('../components/publish/PublishFailure.svelte');
  assert.match(failure, /failureActions\(run, platform\)/);
  assert.match(failure, /actions\.pushAndSubmit && onpushsubmit/);
  assert.match(failure, /onclick=\{onpushsubmit\}/);
  assert.match(failure, /publish:failure\.pushAndSubmit/);
  assert.match(failure, /publish:failure\.openPlayConsole/);
  assert.match(failure, /href=\{actions\.playConsoleUrl\}/);
  assert.doesNotMatch(failure, /instead/i, 'the old advice is gone');
});

test('the Pending panel reopens the plan with the combined step alone; the dialog never sends it by itself', () => {
  const panel = read('../components/publish/PendingChanges.svelte');
  assert.match(panel, /onpushsubmit=\{\(\) => reopenAsPushSubmit\(f\.appId\)\}/);
  assert.match(panel, /dialogSteps = pushAndSubmitSteps\(\)/);
  assert.match(panel, /steps=\{dialogSteps\}/);
  // The ordinary button plans the default again, and the action needs the same state ("ready") as the button.
  assert.match(panel, /dialogSteps = null;\n\s+publishOpen = true;/);
  assert.match(panel, /if \(availability\.state !== 'ready'\) return;/);
  const dialog = read('../components/publish/PublishDialog.svelte');
  // It only asks for a plan: the publish call is still `publish()`, which needs the confirmation of the plan (phrase or step-up).
  assert.match(dialog, /void review\(pushAndSubmitSteps\(\), t\('publish:dialog\.notice\.replanPushSubmit'\)\)/);
  assert.match(dialog, /onpushsubmit=\{plan\?\.combined\?\.offered === false \? undefined : pushAndSubmit\}/);
  assert.match(dialog, /plan\.combined\?\.defaulted && isCombinedPlan\(plan\)/);
  assert.match(dialog, /publish:dialog\.combinedDefaulted/);
  assert.match(dialog, /publish:dialog\.combinedHint/);
  assert.equal((dialog.match(/api\.publishPending\(/g) ?? []).length, 1, 'one place publishes');
});
