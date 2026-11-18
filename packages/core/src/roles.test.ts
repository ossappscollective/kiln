import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actions,
  can,
  canToken,
  isRole,
  isTokenRole,
  lowerRole,
  roles,
  tokenActions,
  tokenForbiddenActions,
  tokenRoles,
} from './roles.ts';

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

test('viewers only read the workspace, repositories, apps, listings, plans, reviews and events', () => {
  const reads = [
    'workspace.read',
    'repositories.read',
    'apps.read',
    'listing.read',
    'plans.read',
    'reviews.read',
    'events.read',
  ];
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

test('members read and sync apps but only owners and admins add or remove them', () => {
  assert.equal(can('member', 'apps.read'), true);
  assert.equal(can('member', 'apps.sync'), true);
  assert.equal(can('member', 'apps.write'), false);
  assert.equal(can('viewer', 'apps.read'), true);
  assert.equal(can('viewer', 'apps.sync'), false);
  assert.equal(can('viewer', 'apps.write'), false);
  assert.equal(can('admin', 'apps.write'), true);
});

test('viewers read release plans, members also write them, nobody below admin gets more', () => {
  assert.equal(can('viewer', 'plans.read'), true);
  assert.equal(can('viewer', 'plans.write'), false);
  assert.equal(can('member', 'plans.read'), true);
  assert.equal(can('member', 'plans.write'), true);
  assert.equal(can('admin', 'plans.write'), true);
});

test('members start CI runs (ci.dispatch) but viewers do not', () => {
  assert.equal(can('owner', 'ci.dispatch'), true);
  assert.equal(can('admin', 'ci.dispatch'), true);
  assert.equal(can('member', 'ci.dispatch'), true);
  assert.equal(can('viewer', 'ci.dispatch'), false);
});

test('listing.read (live listing, drift and history) is open to every role; none of them can write a store', () => {
  for (const role of roles) assert.equal(can(role, 'listing.read'), true, role);
  // There is no action that writes a store listing: reads are the whole of it.
  assert.ok(!actions.some((a) => /^listing\./.test(a) && a !== 'listing.read'));
});

test('only owners and admins manage tokens and webhooks', () => {
  for (const action of ['tokens.read', 'tokens.manage', 'webhooks.read', 'webhooks.manage'] as const) {
    assert.equal(can('owner', action), true, action);
    assert.equal(can('admin', action), true, action);
    assert.equal(can('member', action), false, action);
    assert.equal(can('viewer', action), false, action);
  }
});

test('members and viewers read the event feed', () => {
  assert.equal(can('member', 'events.read'), true);
  assert.equal(can('viewer', 'events.read'), true);
});

test('a token ceiling is never owner', () => {
  assert.deepEqual([...tokenRoles], ['viewer', 'member', 'admin']);
  assert.equal(isTokenRole('owner'), false);
  assert.equal(isTokenRole('admin'), true);
});

test('no token can manage tokens, members, credential values or webhooks', () => {
  for (const action of tokenForbiddenActions) {
    for (const role of roles) assert.equal(canToken(role, null, action), false, `${role} ${action}`);
    assert.equal(tokenActions.includes(action), false, action);
  }
  assert.equal(canToken('admin', null, 'credentials.write'), false);
  assert.equal(canToken('admin', null, 'members.manage'), false);
  assert.equal(canToken('admin', null, 'tokens.manage'), false);
});

test('a token holds the role ceiling, and an allowlist can only narrow it', () => {
  assert.equal(canToken('viewer', null, 'apps.read'), true);
  assert.equal(canToken('viewer', null, 'apps.sync'), false);
  assert.equal(canToken('member', null, 'apps.sync'), true);
  assert.equal(canToken('member', null, 'apps.write'), false);
  assert.equal(canToken('admin', null, 'apps.write'), true);
  // The list narrows...
  assert.equal(canToken('admin', ['apps.read'], 'apps.read'), true);
  assert.equal(canToken('admin', ['apps.read'], 'apps.write'), false);
  // ...and never widens: an action above the ceiling stays out even when it is listed.
  assert.equal(canToken('viewer', ['apps.write'], 'apps.write'), false);
  assert.equal(canToken('member', [], 'apps.read'), false);
});

test('every grantable action is one the admin ceiling can do', () => {
  for (const action of tokenActions) assert.equal(canToken('admin', null, action), true, action);
});

test('lowerRole picks the weaker of two roles', () => {
  assert.equal(lowerRole('admin', 'member'), 'member');
  assert.equal(lowerRole('member', 'owner'), 'member');
  assert.equal(lowerRole('viewer', 'viewer'), 'viewer');
});

test('reviews: everyone reads, members sync and triage, nothing can reply to a store', () => {
  for (const role of roles) assert.equal(can(role, 'reviews.read'), true, role);
  for (const action of ['reviews.sync', 'reviews.triage'] as const) {
    assert.equal(can('viewer', action), false, action);
    assert.equal(can('member', action), true, action);
    assert.equal(can('admin', action), true, action);
  }
  // Replying to a review is a store write and has no action at all (see docs/api/reviews.md).
  assert.ok(!actions.some((a) => /^reviews\./.test(a) && !['reviews.read', 'reviews.sync', 'reviews.triage'].includes(a)));
  // All three can be given to an API token.
  for (const action of ['reviews.read', 'reviews.sync', 'reviews.triage'] as const) {
    assert.equal(canToken('member', null, action), true, action);
  }
  assert.equal(canToken('viewer', null, 'reviews.triage'), false);
});
