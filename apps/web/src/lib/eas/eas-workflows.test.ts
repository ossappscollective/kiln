import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../api.ts';
import {
  activeRuns,
  easWorkflowErrorText,
  startBlocker,
  startForm,
  startSummary,
  workflowFileName,
} from './eas-workflows.ts';

test('the workflow file name: a path in .eas/workflows or a name, else nothing', () => {
  assert.equal(workflowFileName('.eas/workflows/build.yml'), 'build.yml');
  assert.equal(workflowFileName('./.eas/workflows/build.yml'), 'build.yml');
  assert.equal(workflowFileName(' deploy.yaml '), 'deploy.yaml');
  for (const bad of ['', 'build', '.eas/workflows/a/b.yml', 'a b.yml', '../x.yml', 'x.json']) assert.equal(workflowFileName(bad), '');
});

test('the form: problems in sentences, or the body to send without empty parts', () => {
  const bad = startForm({ workflow: 'nope', ref: 'a..b', inputsText: 'oops' });
  assert.equal(bad.body, null);
  assert.equal(bad.problems.length, 3);
  assert.ok(bad.problems[0]?.includes('.eas/workflows'));

  const plain = startForm({ workflow: '.eas/workflows/build.yml', ref: '', inputsText: '' });
  assert.deepEqual(plain, { problems: [], body: { workflow: 'build.yml' } });

  const full = startForm({
    workflow: 'release.yml',
    ref: 'release/1.2',
    inputsText: '# comment\nplatform=ios\nbuild_number = 42\n',
  });
  assert.deepEqual(full.body, { workflow: 'release.yml', ref: 'release/1.2', inputs: { platform: 'ios', build_number: '42' } });

  const many = startForm({ workflow: 'a.yml', ref: '', inputsText: Array.from({ length: 26 }, (_, i) => `k${i}=v`).join('\n') });
  assert.deepEqual(many.problems, ['At most 25 inputs.']);
});

test('the confirmation sentence says what runs where, and that it uses the project secrets', () => {
  assert.equal(
    startSummary({ workflow: 'build.yml', ref: 'main', project: '@acme/trail', inputCount: 0 }),
    'Run build.yml on main in @acme/trail at Expo with no inputs. It runs with the EAS secrets of the project.',
  );
  assert.ok(startSummary({ workflow: 'b.yml', ref: 'main', project: 'p', inputCount: 1 }).includes('with 1 input.'));
  assert.ok(startSummary({ workflow: 'b.yml', ref: 'main', project: 'p', inputCount: 2 }).includes('with 2 inputs.'));
});

test('what blocks a start is said in order: credential, repository, role', () => {
  assert.match(startBlocker({ credentialAvailable: false, hasRepository: false, canStart: false }), /credential/);
  assert.match(startBlocker({ credentialAvailable: true, hasRepository: false, canStart: false }), /repository/);
  assert.match(startBlocker({ credentialAvailable: true, hasRepository: true, canStart: false }), /member or admin/);
  assert.equal(startBlocker({ credentialAvailable: true, hasRepository: true, canStart: true }), '');
});

test('every error code of the API has its own sentence', () => {
  const code = (status: number, error: string, body: Record<string, unknown> = {}) => new ApiError(status, error, 'generic', undefined, body);
  assert.match(easWorkflowErrorText(code(403, 'forbidden')), /member or admin/);
  assert.match(easWorkflowErrorText(code(422, 'expo_not_linked')), /not linked/);
  assert.equal(easWorkflowErrorText(code(422, 'invalid_workflow', { message: 'Expo said no.' })), 'Expo said no.');
  assert.match(easWorkflowErrorText(code(422, 'expo_not_found', {})), /Expo could not be asked/);
  assert.match(easWorkflowErrorText(code(504, 'timeout')), /may have started/);
  assert.match(easWorkflowErrorText(code(429, 'rate_limited')), /Too many requests/);
  assert.match(easWorkflowErrorText(code(500, 'weird')), /server had a problem/);
  assert.match(easWorkflowErrorText(new Error('x')), /Something went wrong/);
});

test('only runs that are not finished are asked about', () => {
  const run = (id: string, active: boolean) => ({ id, active }) as never;
  assert.deepEqual(activeRuns([run('a', true), run('b', false)]).map((r) => r.id), ['a']);
});

test('an empty ref says the default branch', () => {
  assert.equal(
    startSummary({ workflow: 'build.yml', ref: '', project: '@acme/trail', inputCount: 2 }),
    'Run build.yml on the default branch in @acme/trail at Expo with 2 inputs. It runs with the EAS secrets of the project.',
  );
});
