import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actions, can, isRole, roles } from './roles.ts';

test('owners and admins can do everything', () => {
  for (const role of ['owner', 'admin'] as const) {
    for (const action of actions) assert.equal(can(role, action), true, `${role} ${action}`);
  }
});

test('members read but never change credentials or members', () => {
  assert.equal(can('member', 'credentials.read'), true);
  assert.equal(can('member', 'credentials.write'), false);
  assert.equal(can('member', 'members.manage'), false);
});

test('viewers only read the workspace and repositories', () => {
  const reads = ['workspace.read', 'repositories.read'];
  for (const action of reads) assert.equal(can('viewer', action as never), true, action);
  for (const action of actions.filter((a) => !reads.includes(a))) {
    assert.equal(can('viewer', action), false, action);
  }
});

test('members draft repository changes but only owners and admins approve them', () => {
  for (const action of ['repositories.read', 'repositories.scan', 'changesets.write'] as const) {
    assert.equal(can('member', action), true, action);
  }
  assert.equal(can('member', 'repositories.write'), false);
  assert.equal(can('member', 'changesets.approve'), false);
  assert.equal(can('viewer', 'changesets.write'), false);
  assert.equal(can('admin', 'changesets.approve'), true);
});

test('isRole accepts only known roles', () => {
  for (const role of roles) assert.equal(isRole(role), true);
  assert.equal(isRole('root'), false);
  assert.equal(isRole(undefined), false);
});

test('members see the member list but only owners and admins manage it', () => {
  assert.equal(can('member', 'members.read'), true);
  assert.equal(can('viewer', 'members.read'), false);
  assert.equal(can('admin', 'members.manage'), true);
  assert.equal(can('member', 'members.manage'), false);
});
