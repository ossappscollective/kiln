import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, createApi } from '../api.ts';
import type { CredentialSummary } from '../types.ts';
import {
  detectedProject,
  detectionText,
  type ExpoDetection,
  type ExpoLinkView,
  easErrorText,
  expoCredentials,
  expoSummary,
  formStart,
  linkStatus,
  projectReferenceProblem,
  showExpoCard,
} from './eas.ts';

const ID = '2f1c8e5a-7b3d-4c9e-8a61-0d5b9e4f7a12';

const link = (overrides: Partial<ExpoLinkView> = {}): ExpoLinkView => ({
  appId: 'a1',
  credentialId: 'c1',
  credentialLabel: 'Expo robot',
  credentialAvailable: true,
  projectId: ID,
  accountName: 'acme',
  slug: 'trail-notes',
  fullName: '@acme/trail-notes',
  projectName: 'Trail Notes',
  verifiedAt: 1_000_000,
  linkedBy: 'u1',
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  ...overrides,
});

const credential = (id: string, kind: string): CredentialSummary => ({
  id,
  kind,
  label: id,
  createdAt: 1,
  rotatedAt: null,
});

const apiError = (code: string, status = 422, body: Record<string, unknown> = {}, retryAfter?: number) =>
  new ApiError(status, code, 'generic', retryAfter, { error: code, ...body });

test('a project reference: a UUID or @account/slug (the @ is optional); nothing else', () => {
  assert.equal(projectReferenceProblem(ID), '');
  assert.equal(projectReferenceProblem(ID.toUpperCase()), '');
  assert.equal(projectReferenceProblem('  @acme/trail-notes '), '');
  assert.equal(projectReferenceProblem('acme/trail.notes_2'), '');
  assert.match(projectReferenceProblem(''), /Enter the project/);
  assert.match(projectReferenceProblem('trail-notes'), /neither a project id/);
  assert.match(projectReferenceProblem('@acme/'), /neither a project id/);
  assert.match(projectReferenceProblem('https://expo.dev/accounts/acme/projects/trail-notes'), /neither/);
});

test('only credentials of the Expo kind are offered', () => {
  const list = [credential('a', 'github_token'), credential('b', 'expo'), credential('c', 'expo')];
  assert.deepEqual(expoCredentials(list).map((c) => c.id), ['b', 'c']);
  assert.deepEqual(expoCredentials(null), []);
});

test('the form starts from the saved link, else from another record of the same app, else empty', () => {
  assert.deepEqual(formStart(link(), []), { credentialId: 'c1', project: '@acme/trail-notes', fromSibling: false });
  assert.deepEqual(formStart(link({ credentialAvailable: false }), []), {
    credentialId: '',
    project: '@acme/trail-notes',
    fromSibling: false,
  });
  assert.deepEqual(formStart(null, [null, link({ credentialId: 'c9' })]), {
    credentialId: 'c9',
    project: '@acme/trail-notes',
    fromSibling: true,
  });
  assert.deepEqual(formStart(null, [link({ credentialAvailable: false })]), { credentialId: '', project: '', fromSibling: false });
  assert.deepEqual(formStart(null, []), { credentialId: '', project: '', fromSibling: false });
});

test('the card shows when it can matter: a link, an Expo credential, or an Expo repository', () => {
  assert.equal(showExpoCard({ links: [null], expoCredentialCount: 0, repositoryKinds: [null, 'fastlane'] }), false);
  assert.equal(showExpoCard({ links: [link()], expoCredentialCount: 0, repositoryKinds: [] }), true);
  assert.equal(showExpoCard({ links: [null], expoCredentialCount: 1, repositoryKinds: [] }), true);
  assert.equal(showExpoCard({ links: [null], expoCredentialCount: 0, repositoryKinds: ['expo'] }), true);
  assert.equal(showExpoCard({ links: [null], expoCredentialCount: 0, repositoryKinds: ['both'] }), true);
});

test('the summary of the collapsed card', () => {
  assert.equal(expoSummary([null, null]), 'Not linked');
  assert.equal(expoSummary([link(), link({ appId: 'a2' })]), '@acme/trail-notes');
  assert.equal(expoSummary([link(), link({ appId: 'a2', fullName: '@acme/other' })]), '2 projects');
});

test('the status of a link: when Expo last confirmed it, or that the credential is gone', () => {
  const ok = linkStatus(link({ verifiedAt: 1_000_000 }), 1_000_000 + 3 * 60_000);
  assert.deepEqual(ok, { tone: 'ok', text: 'Confirmed with Expo 3 minutes ago.' });
  const gone = linkStatus(link({ credentialAvailable: false }), 5);
  assert.equal(gone.tone, 'warn');
  assert.match(gone.text, /deleted/);
});

test('detection: what to say, and what to put in the form', () => {
  const withId: ExpoDetection = {
    detected: { projectId: ID, owner: 'acme', slug: 'trail-notes', fullName: '@acme/trail-notes', path: 'app.json' },
    reason: null,
    message: null,
  };
  assert.match(detectionText(withId), /Found the project id/);
  assert.equal(detectedProject(withId), ID);
  const nameOnly: ExpoDetection = {
    detected: { projectId: null, owner: 'acme', slug: 'trail-notes', fullName: '@acme/trail-notes', path: 'app.json' },
    reason: null,
    message: null,
  };
  assert.match(detectionText(nameOnly), /look it up by name/);
  assert.equal(detectedProject(nameOnly), '@acme/trail-notes');
  const none: ExpoDetection = { detected: null, reason: 'no_app_json', message: 'There is no app.json.' };
  assert.equal(detectionText(none), 'There is no app.json.');
  assert.equal(detectedProject(none), '');
  assert.match(detectionText({ detected: null, reason: null, message: null }), /No Expo project/);
});

test('every error code of the Expo routes has a sentence of its own (not the GitHub wording)', () => {
  assert.match(easErrorText(apiError('forbidden', 403)), /owner or an admin/);
  assert.match(easErrorText(apiError('credential_kind')), /Expo access token kind/);
  assert.doesNotMatch(easErrorText(apiError('credential_kind')), /GitHub/);
  assert.match(easErrorText(apiError('credential_not_found')), /no longer exists/);
  assert.match(easErrorText(apiError('credential_unreadable')), /Enter its token again/);
  assert.equal(easErrorText(apiError('expo_not_found', 422, { message: 'Expo has no such project.' })), 'Expo has no such project.');
  assert.equal(easErrorText(apiError('expo_auth', 422, { message: 'Expo did not accept the access token.' })), 'Expo did not accept the access token.');
  assert.match(easErrorText(apiError('expo_unavailable', 502)), /Expo could not be asked/);
  assert.equal(easErrorText(apiError('timeout', 504)), 'Expo took too long to answer. Try again.');
  assert.doesNotMatch(easErrorText(apiError('timeout', 504)), /GitHub/);
  assert.equal(easErrorText(apiError('rate_limited', 429, {}, 90)), 'Too many requests. Try again in 2 minutes.');
  assert.match(easErrorText(apiError('invalid_project')), /Choose a credential/);
  assert.match(easErrorText(apiError('invalid_request', 400)), /Choose a credential/);
  assert.match(easErrorText(apiError('boom', 500)), /server had a problem/);
  assert.match(easErrorText(new Error('x')), /Something went wrong/);
});

test('the API methods: paths, verbs and bodies', async () => {
  const calls: { path: string; method: string; body: string | undefined }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ path: String(input), method: String(init?.method), body: init?.body === undefined ? undefined : String(init.body) });
    return init?.method === 'DELETE'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify({ link: null }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const api = createApi({ fetch: fetchImpl });
  await api.expoLink('w 1', 'a/1');
  await api.setExpoLink('w1', 'a1', { credentialId: 'c1', project: '@acme/trail-notes' });
  assert.equal(await api.removeExpoLink('w1', 'a1'), undefined);
  await api.detectExpoProject('w1', 'a1');
  assert.deepEqual(calls, [
    { path: '/api/workspaces/w%201/apps/a%2F1/expo', method: 'GET', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/expo', method: 'PUT', body: JSON.stringify({ credentialId: 'c1', project: '@acme/trail-notes' }) },
    { path: '/api/workspaces/w1/apps/a1/expo', method: 'DELETE', body: undefined },
    { path: '/api/workspaces/w1/apps/a1/expo/detect', method: 'GET', body: undefined },
  ]);
});
