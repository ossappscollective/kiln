import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assignableBy,
  decideRemoval,
  decideRoleChange,
  invitableBy,
  isInvitableRole,
} from './members.ts';
import { roles } from './roles.ts';

test('nobody can invite an owner; only owners invite admins', () => {
  assert.deepEqual(invitableBy('owner'), ['admin', 'member', 'viewer']);
  assert.deepEqual(invitableBy('admin'), ['member', 'viewer']);
  assert.deepEqual(invitableBy('member'), []);
  assert.deepEqual(invitableBy('viewer'), []);
  assert.equal(isInvitableRole('owner'), false);
  assert.equal(isInvitableRole('admin'), true);
});

test('owners assign any role, admins only member or viewer, others nothing', () => {
  assert.deepEqual(assignableBy('owner'), [...roles]);
  assert.deepEqual(assignableBy('admin'), ['member', 'viewer']);
  assert.deepEqual(assignableBy('member'), []);
});

const change = (
  actorRole: (typeof roles)[number],
  targetRole: (typeof roles)[number],
  newRole: (typeof roles)[number],
  ownerCount = 2,
) => decideRoleChange({ actorRole, targetRole, newRole, ownerCount });

test('role changes: owners may do anything while another owner remains', () => {
  for (const target of roles) for (const next of roles) assert.deepEqual(change('owner', target, next), { ok: true });
});

test('the last owner cannot be demoted, but may keep the owner role', () => {
  assert.deepEqual(change('owner', 'owner', 'admin', 1), { ok: false, reason: 'last_owner' });
  assert.deepEqual(change('owner', 'owner', 'viewer', 1), { ok: false, reason: 'last_owner' });
  assert.deepEqual(change('owner', 'owner', 'owner', 1), { ok: true });
});

test('role changes: admins cannot touch admins or owners, or hand out admin or owner', () => {
  assert.deepEqual(change('admin', 'member', 'viewer'), { ok: true });
  assert.deepEqual(change('admin', 'viewer', 'member'), { ok: true });
  assert.deepEqual(change('admin', 'member', 'admin'), { ok: false, reason: 'forbidden' });
  assert.deepEqual(change('admin', 'member', 'owner'), { ok: false, reason: 'forbidden' });
  assert.deepEqual(change('admin', 'admin', 'member'), { ok: false, reason: 'forbidden' });
  assert.deepEqual(change('admin', 'owner', 'member'), { ok: false, reason: 'forbidden' });
  assert.deepEqual(change('admin', 'owner', 'member', 1), { ok: false, reason: 'forbidden' });
});

test('role changes: members and viewers may not change roles', () => {
  assert.deepEqual(change('member', 'viewer', 'member'), { ok: false, reason: 'forbidden' });
  assert.deepEqual(change('viewer', 'viewer', 'viewer'), { ok: false, reason: 'forbidden' });
});

const remove = (
  actorRole: (typeof roles)[number],
  targetRole: (typeof roles)[number],
  self: boolean,
  ownerCount = 2,
) => decideRemoval({ actorRole, targetRole, self, ownerCount });

test('removal: anyone may leave, except the last owner', () => {
  for (const role of ['admin', 'member', 'viewer'] as const) {
    assert.deepEqual(remove(role, role, true), { ok: true });
  }
  assert.deepEqual(remove('owner', 'owner', true, 2), { ok: true });
  assert.deepEqual(remove('owner', 'owner', true, 1), { ok: false, reason: 'last_owner' });
});

test('removal: the last owner cannot be removed, by an owner or anyone else', () => {
  assert.deepEqual(remove('owner', 'owner', false, 1), { ok: false, reason: 'last_owner' });
  assert.deepEqual(remove('admin', 'owner', false, 1), { ok: false, reason: 'forbidden' });
});

test('removal: owners remove anyone, admins only members and viewers, others nobody', () => {
  assert.deepEqual(remove('owner', 'admin', false), { ok: true });
  assert.deepEqual(remove('owner', 'owner', false, 2), { ok: true });
  assert.deepEqual(remove('admin', 'member', false), { ok: true });
  assert.deepEqual(remove('admin', 'viewer', false), { ok: true });
  assert.deepEqual(remove('admin', 'admin', false), { ok: false, reason: 'forbidden' });
  assert.deepEqual(remove('admin', 'owner', false), { ok: false, reason: 'forbidden' });
  assert.deepEqual(remove('member', 'viewer', false), { ok: false, reason: 'forbidden' });
  assert.deepEqual(remove('viewer', 'member', false), { ok: false, reason: 'forbidden' });
});
