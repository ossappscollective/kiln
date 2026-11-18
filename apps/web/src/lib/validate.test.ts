import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emailProblem, passwordProblem, requiredProblem } from './validate.ts';

test('emailProblem', () => {
  assert.equal(emailProblem('ada@example.com'), '');
  assert.equal(emailProblem(' ada@example.com '), '');
  assert.match(emailProblem(''), /Enter your email/);
  assert.match(emailProblem('ada@'), /name@example\.com/);
  assert.match(emailProblem('ada example@x.io'), /name@example\.com/);
});

test('passwordProblem counts what was typed', () => {
  assert.equal(passwordProblem('x'.repeat(12), 12), '');
  assert.equal(passwordProblem('short', 12), 'Use at least 12 characters. You have 5.');
  assert.equal(passwordProblem('', 12), 'Enter a password.');
});

test('requiredProblem', () => {
  assert.equal(requiredProblem('Ada', 'your name'), '');
  assert.equal(requiredProblem('  ', 'your name'), 'Enter your name.');
});
