import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AssetProblem, StagedAssetView, StagedChangesView, StagedTextView } from '@mrm/core';
import { ApiError } from './api.ts';
import {
  DRAFT_ENV,
  type DraftPreview,
  type StoreDraftConfig,
  canConfirmPush,
  canPush,
  canStage,
  cellStagedText,
  classifyPushFailure,
  confirmPhrase,
  fieldStage,
  mayConfirmAgain,
  normalizeText,
  previewSummaryText,
  pushAvailability,
  pushBlockedReason,
  resultText,
  setStaging,
  shouldReloadStaged,
  stageAssetsBody,
  stagedSetId,
  stagingError,
  trayCountText,
} from './staged.ts';
import type { AssetItem, DriftField } from './types.ts';

const config = (over: Partial<StoreDraftConfig> = {}): StoreDraftConfig => ({
  enabled: true,
  envName: DRAFT_ENV,
  submit: { implemented: false, note: 'n' },
  limits: { maxItems: 600, maxTextChars: 20000, maxLocaleChars: 35, maxAssetFilesPerPush: 100, maxAssetBytesPerPush: 64 * 1024 * 1024, maxAssetFileBytes: 8 * 1024 * 1024 },
  ...over,
});

const text = (over: Partial<StagedTextView> = {}): StagedTextView => ({
  id: 't1',
  kind: 'listing_text',
  locale: 'en-US',
  field: 'description',
  label: 'Description',
  source: 'repo',
  value: 'Hello',
  valueHash: 'h',
  limit: 4000,
  unit: 'characters',
  before: 'Old',
  status: 'changed',
  problems: [],
  pushedAt: null,
  pushed: false,
  createdBy: 'u',
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const set = (over: Partial<StagedAssetView> = {}): StagedAssetView => ({
  id: 'en-US/screenshot:iphone_6_5',
  kind: 'asset',
  locale: 'en-US',
  slot: { kind: 'screenshot', device: 'iphone_6_5' },
  slotKey: 'screenshot:iphone_6_5',
  label: 'Screenshots',
  source: 'repo',
  files: [{ id: 'f1', position: 0, path: 'a/1.png', commit: 'c', oid: 'o1', bytes: 10, width: 1, height: 1, format: 'png', hasAlpha: false }],
  status: 'changed',
  problems: [],
  pushedAt: null,
  pushed: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const view = (over: Partial<StagedChangesView> = {}): StagedChangesView => ({
  app: { id: 'a1', name: 'Demo', platform: 'ios', store: 'appstoreconnect' },
  text: [],
  assets: [],
  totals: { text: 0, assetSets: 0, assetFiles: 0, errors: 0, warnings: 0, changed: 0 },
  valid: true,
  pushable: { textFields: [] },
  limits: config().limits,
  ...over,
});

const field = (over: Partial<DriftField> = {}): DriftField => ({
  locale: 'en-US',
  field: 'description',
  label: 'Description',
  limit: 4000,
  unit: 'characters',
  status: 'repo-ahead',
  repo: { value: 'New', observedAt: 1, sourceRef: null, source: 'repo' },
  db: { value: 'Old', observedAt: 1, sourceRef: null, source: 'store' },
  live: { value: 'Old', observedAt: 1, sourceRef: null, source: 'store' },
  problems: { repo: [], live: [] },
  ...over,
});

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  path: 'fastlane/metadata/en-US/images/1.png',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_5',
  deviceLabel: 'iPhone 6.5',
  order: 1,
  bytes: 1000,
  width: 1242,
  height: 2688,
  format: 'png',
  hasAlpha: false,
  oid: 'o1',
  read: 'read',
  origin: 'store',
  ...over,
});

const problem = (over: Partial<AssetProblem> = {}): AssetProblem => ({ rule: 'r', severity: 'error', message: 'Too small.', source: 's', verified: true, ...over });

const stagingInput = (over: Partial<Parameters<typeof setStaging>[0]> = {}): Parameters<typeof setStaging>[0] => ({
  role: 'member',
  platform: 'ios',
  locale: 'en-US',
  kind: 'screenshot',
  device: 'iphone_6_5',
  assets: [asset()],
  setProblems: [],
  problemsByPath: {},
  commit: 'a'.repeat(40),
  view: null,
  ...over,
});

const apiError = (code: string, status = 409, body: Record<string, unknown> = {}, retryAfter?: number) =>
  new ApiError(status, code, `msg ${code}`, retryAfter, { message: `msg ${code}`, ...body });

const preview = (over: Partial<DraftPreview> = {}): DraftPreview => ({
  app: { id: 'a1', name: 'Demo', platform: 'ios', store: 'appstoreconnect' },
  version: { id: 'v', versionString: '2.0', state: 'PREPARE_FOR_SUBMISSION' },
  text: [],
  assets: [],
  summary: { textChanged: 1, textUnchanged: 0, assetSetsChanged: 0, assetSetsUnchanged: 0, filesToUpload: 0, filesToRemove: 0, nothingToDo: false },
  submits: false,
  confirmHash: 'f'.repeat(64),
  warnings: [],
  readAt: 1,
  ...over,
});

// --- rights and the switch ------------------------------------------------------------------

test('staging is for member and up, pushing for admin and up', () => {
  assert.equal(canStage('viewer'), false);
  assert.equal(canStage('member'), true);
  assert.equal(canPush('member'), false);
  assert.equal(canPush('admin'), true);
  assert.equal(canPush('owner'), true);
});

test('the push is unavailable below admin, when the switch is off, unread or failed to read', () => {
  assert.equal(pushAvailability('member', config(), false).state, 'role');
  assert.equal(pushAvailability('admin', null, true).state, 'unknown');
  assert.equal(pushAvailability('admin', null, false).state, 'loading');
  assert.equal(pushAvailability('admin', config(), false).state, 'ready');
  const off = pushAvailability('admin', config({ enabled: false }), false);
  assert.equal(off.state, 'off');
  if (off.state === 'off') assert.match(off.message, /MRM_STORE_DRAFT_WRITE_ENABLED=true/);
});

test('a role check beats a switch that is off, and a blank env name falls back to the constant', () => {
  assert.equal(pushAvailability('viewer', config({ enabled: false }), false).state, 'role');
  const off = pushAvailability('owner', config({ enabled: false, envName: '' }), false);
  if (off.state === 'off') assert.match(off.message, /MRM_STORE_DRAFT_WRITE_ENABLED/);
});

// --- the tray -------------------------------------------------------------------------------

test('counts and why a push cannot start', () => {
  assert.equal(trayCountText(null), 'Nothing staged');
  assert.equal(trayCountText(view()), 'Nothing staged');
  assert.equal(trayCountText(view({ text: [text()], assets: [set()] })), '1 text, 1 graphic set (1 file)');
  assert.equal(trayCountText(view({ text: [text(), text({ id: 't2' })] })), '2 texts');
  assert.match(pushBlockedReason(null) ?? '', /not loaded/);
  assert.match(pushBlockedReason(view()) ?? '', /Nothing is staged/);
  assert.match(pushBlockedReason(view({ text: [text()], valid: false })) ?? '', /error/);
  assert.equal(pushBlockedReason(view({ text: [text()] })), null);
});

// --- staging a text -------------------------------------------------------------------------

test('normalizeText: line breaks and trailing white space', () => {
  assert.equal(normalizeText('a  \r\nb\t\r\n\r\n'), 'a\nb');
});

test('"Stage from repo" is offered for a differing field with a repository value', () => {
  const s = fieldStage({ role: 'member', platform: 'ios', field: field(), view: null });
  assert.equal(s.state, 'available');
  assert.equal(s.staged, null);
});

test('an identical field offers nothing, but a staged one is still reported', () => {
  assert.equal(fieldStage({ role: 'member', platform: 'ios', field: field({ status: 'identical' }), view: null }).state, 'hidden');
  const staged = fieldStage({ role: 'member', platform: 'ios', field: field({ status: 'identical' }), view: view({ text: [text()] }) });
  assert.equal(staged.state, 'hidden');
  assert.ok(staged.staged);
});

test('a field a draft push cannot write is said so, per platform', () => {
  const s = fieldStage({ role: 'member', platform: 'ios', field: field({ field: 'subtitle' }), view: null });
  assert.equal(s.state, 'not_pushable');
  assert.match(s.reason ?? '', /app information/);
  assert.equal(fieldStage({ role: 'member', platform: 'android', field: field({ field: 'short_description' }), view: null }).state, 'available');
  assert.equal(fieldStage({ role: 'member', platform: 'android', field: field({ field: 'keywords' }), view: null }).state, 'not_pushable');
});

test('a viewer, a missing repository value and a project locale disable the button with a reason', () => {
  assert.equal(fieldStage({ role: 'viewer', platform: 'ios', field: field(), view: null }).state, 'disabled');
  const none = fieldStage({ role: 'member', platform: 'ios', field: field({ repo: { value: null, observedAt: null, sourceRef: null, source: null } }), view: null });
  assert.equal(none.state, 'disabled');
  assert.match(none.reason ?? '', /no value/);
  const blank = fieldStage({ role: 'member', platform: 'ios', field: field({ repo: { value: '  ', observedAt: 1, sourceRef: null, source: 'repo' } }), view: null });
  assert.equal(blank.state, 'disabled');
  assert.equal(fieldStage({ role: 'member', platform: 'ios', field: field({ locale: 'default' }), view: null }).state, 'disabled');
});

test('a staged text that equals the repository text is up to date, an older one is not', () => {
  const same = fieldStage({ role: 'member', platform: 'ios', field: field({ repo: { value: 'Hello  \r\n', observedAt: 1, sourceRef: null, source: 'repo' } }), view: view({ text: [text()] }) });
  assert.equal(same.upToDate, true);
  const older = fieldStage({ role: 'member', platform: 'ios', field: field(), view: view({ text: [text()] }) });
  assert.equal(older.upToDate, false);
  assert.equal(older.state, 'available');
});

test('the grid marker finds the staged text of a cell', () => {
  assert.ok(cellStagedText(view({ text: [text()] }), field()));
  assert.equal(cellStagedText(view({ text: [text()] }), field({ locale: 'de-DE' })), null);
  assert.equal(cellStagedText(null, field()), null);
  assert.equal(cellStagedText(view({ text: [text()] }), null), null);
});

// --- staging a set of graphics --------------------------------------------------------------

test('a set of PNG files of a store locale can be staged, with its paths in order', () => {
  const r = setStaging(stagingInput({ assets: [asset({ path: 'b.png', order: 1 }), asset({ path: 'a.png', order: 2 })] }));
  assert.equal(r.canStage, true);
  assert.deepEqual(r.paths, ['b.png', 'a.png']);
  assert.equal(r.id, 'en-US/screenshot:iphone_6_5');
  assert.equal(r.id, stagedSetId('en-US', 'screenshot', 'iphone_6_5'));
});

test('a set is refused, with the reason, for a role, a locale, a kind, a format, a size and a count', () => {
  assert.match(setStaging(stagingInput({ role: 'viewer' })).reason ?? '', /role/);
  assert.match(setStaging(stagingInput({ locale: 'default' })).reason ?? '', /locale/);
  assert.match(setStaging(stagingInput({ commit: null })).reason ?? '', /commit/);
  assert.match(setStaging(stagingInput({ kind: 'preview', device: 'iphone_6_5' })).reason ?? '', /previews/);
  assert.match(setStaging(stagingInput({ kind: 'app_icon', device: null })).reason ?? '', /icon/);
  assert.match(setStaging(stagingInput({ platform: 'android', kind: 'promo_graphic', device: null })).reason ?? '', /promo graphic/);
  assert.match(setStaging(stagingInput({ assets: [asset({ format: 'webp' })] })).reason ?? '', /PNG or JPEG/);
  assert.match(setStaging(stagingInput({ assets: [asset({ bytes: 9 * 1024 * 1024 })] })).reason ?? '', /larger than/);
  assert.match(setStaging(stagingInput({ assets: [asset({ read: 'too_large' })] })).reason ?? '', /not read/);
  assert.match(setStaging(stagingInput({ assets: [asset({ origin: 'project' })] })).reason ?? '', /project/);
  const many = Array.from({ length: 11 }, (_, i) => asset({ path: `p${i}.png`, oid: `o${i}` }));
  assert.match(setStaging(stagingInput({ assets: many })).reason ?? '', /at most 10/);
  const two = [asset({ kind: 'feature_graphic', device: null }), asset({ kind: 'feature_graphic', device: null, path: 'x.png' })];
  assert.match(setStaging(stagingInput({ platform: 'android', kind: 'feature_graphic', device: null, assets: two })).reason ?? '', /at most 1 file/);
});

test('a spec error of the file or of the set blocks staging; a warning does not', () => {
  const a = asset();
  assert.match(setStaging(stagingInput({ problemsByPath: { [a.path]: [problem()] } })).reason ?? '', /Fix the spec problem first: Too small/);
  assert.match(setStaging(stagingInput({ setProblems: [problem({ message: 'Too many.' })] })).reason ?? '', /Too many/);
  assert.equal(setStaging(stagingInput({ problemsByPath: { [a.path]: [problem({ severity: 'warning' })] } })).canStage, true);
});

test('a staged set is current when its blob ids match the repository files, else outdated', () => {
  const current = setStaging(stagingInput({ view: view({ assets: [set()] }) }));
  assert.equal(current.stagedState, 'current');
  const outdated = setStaging(stagingInput({ assets: [asset({ oid: 'changed' })], view: view({ assets: [set()] }) }));
  assert.equal(outdated.stagedState, 'outdated');
  assert.equal(outdated.canStage, true);
  assert.equal(setStaging(stagingInput()).stagedState, 'none');
});

test('the request of "Stage for store" names the exact paths and the commit; the icon has no device', () => {
  assert.deepEqual(stageAssetsBody('en-US', 'screenshot', 'iphone_6_5', ['a.png'], 'c'), {
    locale: 'en-US',
    kind: 'screenshot',
    device: 'iphone_6_5',
    from: 'repo',
    paths: ['a.png'],
    commit: 'c',
  });
  const icon = stageAssetsBody('en-US', 'icon', null, ['i.png'], null);
  assert.equal('device' in icon, false);
  assert.equal('commit' in icon, false);
});

// --- errors of staging ----------------------------------------------------------------------

test('staging errors name what to do', () => {
  assert.match(stagingError(apiError('field_not_pushable', 422, { allowed: ['description', 'keywords'] })), /description, keywords/);
  assert.match(stagingError(apiError('source_not_supported', 422)), /documented gap/);
  assert.match(stagingError(apiError('forbidden', 403)), /role/);
  assert.match(stagingError(apiError('rate_limited', 429, {}, 12)), /12 seconds/);
  assert.equal(stagingError(apiError('no_assets', 422)), 'msg no_assets');
  assert.equal(stagingError(new Error('x')), 'Something went wrong. Try again.');
});

// --- errors of the push: every code of docs/api/staged-changes.md ----------------------------

test('store_draft_disabled names the switch', () => {
  const f = classifyPushFailure(apiError('store_draft_disabled'));
  assert.equal(f.kind, 'disabled');
  assert.match(f.message, /MRM_STORE_DRAFT_WRITE_ENABLED/);
});

test('state_changed carries the new preview, and nothing is written', () => {
  const next = preview({ confirmHash: 'e'.repeat(64) });
  const f = classifyPushFailure(apiError('state_changed', 409, { preview: next }));
  assert.equal(f.kind, 'state_changed');
  if (f.kind === 'state_changed') {
    assert.equal(f.next?.confirmHash, 'e'.repeat(64));
    assert.match(f.message, /nothing was written/);
  }
  const bad = classifyPushFailure(apiError('state_changed', 409, { preview: { nope: true } }));
  if (bad.kind === 'state_changed') assert.equal(bad.next, null);
});

test('write_in_progress may be confirmed again by the person; outcome_unknown never', () => {
  const busy = classifyPushFailure(apiError('write_in_progress'));
  assert.equal(busy.kind, 'write_in_progress');
  assert.equal(mayConfirmAgain(busy), true);
  const unknown = classifyPushFailure(apiError('outcome_unknown'));
  assert.equal(unknown.kind, 'outcome_unknown');
  assert.equal(mayConfirmAgain(unknown), false);
  assert.match(unknown.message, /Do not push again yet: preview again/);
});

test('a cut connection or a server error during the push is an unknown outcome; during the preview it is just an error', () => {
  const cut = classifyPushFailure(new ApiError(0, 'network', 'Cannot reach the server.'));
  assert.equal(cut.kind, 'outcome_unknown');
  assert.equal(mayConfirmAgain(cut), false);
  assert.equal(classifyPushFailure(new ApiError(500, 'error', 'The server had a problem.')).kind, 'outcome_unknown');
  assert.equal(classifyPushFailure(new ApiError(0, 'network', 'x'), 'preview').kind, 'other');
  assert.equal(classifyPushFailure(new Error('boom')).kind, 'other');
});

test('draft_partial in both shapes (502 completed and failed, 409 items)', () => {
  const step = { type: 'text', locale: 'en-US', target: 'description', outcome: 'applied' };
  const a = classifyPushFailure(apiError('draft_partial', 502, { completed: [step], failed: { type: 'asset', locale: 'en-US', target: 'APP_IPHONE_65' } }));
  assert.equal(a.kind, 'partial');
  if (a.kind === 'partial') {
    assert.equal(a.completed.length, 1);
    assert.equal(a.failed?.target, 'APP_IPHONE_65');
  }
  const items = { text: [{ locale: 'en-US', field: 'description', matches: true }], assets: [{ locale: 'en-US', slotKey: 'x', matches: false }] };
  const b = classifyPushFailure(apiError('draft_partial', 409, { items }));
  if (b.kind === 'partial') {
    assert.equal(b.matching, 1);
    assert.equal(b.total, 2);
  }
  assert.equal(mayConfirmAgain(a), false);
});

test('write_failed with not_applied says nothing was written; without it the outcome is unknown', () => {
  assert.equal(classifyPushFailure(apiError('write_failed', 502, { outcome: 'not_applied' })).kind, 'not_applied');
  assert.equal(classifyPushFailure(apiError('write_failed', 502)).kind, 'outcome_unknown');
  assert.equal(mayConfirmAgain(classifyPushFailure(apiError('write_failed', 502, { outcome: 'not_applied' }))), true);
});

test('Google and Apple refusals each get a sentence', () => {
  assert.match(classifyPushFailure(apiError('draft_not_allowed')).message, /never retries without holding the changes back/);
  assert.match(classifyPushFailure(apiError('changes_in_review')).message, /never cancels/);
  assert.match(classifyPushFailure(apiError('no_editable_version', 422)).message, /App Store Connect/);
  for (const code of ['store_auth', 'store_forbidden', 'store_not_found', 'store_rejected']) {
    assert.match(classifyPushFailure(apiError(code, 422)).message, /refused/);
  }
  assert.match(classifyPushFailure(apiError('store_unavailable', 502)).message, /nothing was changed/);
  assert.match(classifyPushFailure(apiError('timeout', 504)).message, /preview again/);
});

test('rate_limited reports the wait and is never retried by the app', () => {
  const f = classifyPushFailure(apiError('rate_limited', 429, {}, 30));
  assert.equal(f.kind, 'rate_limited');
  if (f.kind === 'rate_limited') assert.equal(f.retryAfter, 30);
  assert.match(f.message, /30 seconds/);
  assert.match(f.message, /never retries/);
  assert.equal(mayConfirmAgain(f), false);
});

test('staged_invalid, nothing_staged and the changed files', () => {
  const problems = [{ severity: 'error', code: 'too_long', message: 'Too long.' }];
  const invalid = classifyPushFailure(apiError('staged_invalid', 422, { problems }));
  assert.equal(invalid.kind, 'invalid');
  if (invalid.kind === 'invalid') assert.equal(invalid.problems.length, 1);
  assert.equal(classifyPushFailure(apiError('nothing_staged', 422)).kind, 'invalid');
  assert.equal(classifyPushFailure(apiError('asset_changed', 422)).kind, 'restage');
  assert.match(classifyPushFailure(apiError('asset_unreadable', 422)).message, /Stage the set again/);
});

test('credential and sync codes pass the message; a 403 names the role', () => {
  assert.equal(classifyPushFailure(apiError('credential_wrong_kind', 422)).message, 'msg credential_wrong_kind');
  assert.match(classifyPushFailure(apiError('app_not_synced', 422)).message, /Sync the app/);
  assert.match(classifyPushFailure(apiError('forbidden', 403)).message, /admin or owner/);
});

test('the staged view is read again where something may have changed on the server', () => {
  assert.equal(shouldReloadStaged(classifyPushFailure(apiError('draft_partial', 502))), true);
  assert.equal(shouldReloadStaged(classifyPushFailure(apiError('asset_changed', 422))), true);
  assert.equal(shouldReloadStaged(classifyPushFailure(apiError('outcome_unknown'))), true);
  assert.equal(shouldReloadStaged(classifyPushFailure(apiError('rate_limited', 429))), false);
});

// --- the dialog -----------------------------------------------------------------------------

test('the push needs the typed name and the acknowledgement, and something to do', () => {
  const p = preview();
  assert.equal(confirmPhrase(p), 'Demo');
  assert.equal(canConfirmPush(p, 'demo', true), true);
  assert.equal(canConfirmPush(p, 'Demo', false), false);
  assert.equal(canConfirmPush(p, '', true), false);
  assert.equal(canConfirmPush(p, 'Other', true), false);
  assert.equal(canConfirmPush(preview({ summary: { ...p.summary, nothingToDo: true } }), 'Demo', true), false);
});

test('the summary and the result always say nothing was submitted', () => {
  assert.match(previewSummaryText(preview().summary), /1 text will change/);
  assert.match(previewSummaryText({ ...preview().summary, nothingToDo: true }), /Nothing to do/);
  const r = resultText({
    app: preview().app,
    version: null,
    steps: [],
    counts: { applied: 2, alreadySame: 1, filesUploaded: 3, filesRemoved: 0 },
    commit: 'none',
    draft: true,
    submitted: false,
    confirmedByReread: false,
    pushedAt: 1,
    note: '',
  });
  assert.match(r, /2 changes written to the draft, 1 already the same, 3 files uploaded/);
  assert.match(r, /Nothing is submitted/);
});
