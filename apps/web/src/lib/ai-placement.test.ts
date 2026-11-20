import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canStagePlacement,
  PLACEMENT_NOT_APPLIED,
  placementLabel,
  placementLine,
  stageInLabel,
  stageTextsLabel,
  TRACKING_ONLY_NOTE,
} from './ai-placement.ts';

test('a placement is a plain line, not "for the full description"', () => {
  assert.equal(placementLine('title'), 'Where it would go: Title');
  assert.equal(placementLine('keywords'), 'Where it would go: Keyword field');
  assert.equal(placementLine('full_description'), 'Where it would go: Full description');
  assert.equal(placementLine('name'), 'Where it would go: Title (App Store name)');
  assert.equal(placementLine(null), 'Where it would go: no listing field, tracking only');
  assert.equal(placementLabel('something_else'), 'something_else');
  const fields = ['title', 'name', 'keywords', 'subtitle', 'short_description', 'full_description'];
  for (const f of fields) {
    assert.doesNotMatch(placementLine(f), /^For the/i);
  }
});

test('the sentence says it is a suggestion and that nothing changes until staged; accepting only tracks', () => {
  assert.equal(
    PLACEMENT_NOT_APPLIED,
    'This is a suggestion for what to put there. Nothing changes until you stage it.',
  );
  assert.match(TRACKING_ONLY_NOTE, /only tracks the keyword/);
  assert.match(TRACKING_ONLY_NOTE, /does not change your listing/);
});

test('the buttons name the field they stage into', () => {
  assert.equal(stageInLabel('title'), 'Stage in title');
  assert.equal(stageInLabel('name'), 'Stage in title');
  assert.equal(stageInLabel('keywords'), 'Stage in keyword field');
  assert.equal(stageInLabel('short_description'), 'Stage in short description');
  assert.equal(stageInLabel('full_description'), 'Stage in full description');
  assert.equal(stageTextsLabel(['keywords']), 'Stage in keyword field');
  assert.equal(stageTextsLabel(['keywords', 'description']), 'Stage 2 texts');
});

test('the App Store name and subtitle cannot be staged by a draft push; the other fields can', () => {
  assert.equal(canStagePlacement('app_store', 'keywords'), true);
  assert.equal(canStagePlacement('app_store', 'description'), true);
  assert.equal(canStagePlacement('app_store', 'name'), false);
  assert.equal(canStagePlacement('app_store', 'subtitle'), false);
  assert.equal(canStagePlacement('google_play', 'title'), true);
  assert.equal(canStagePlacement('google_play', 'short_description'), true);
});
