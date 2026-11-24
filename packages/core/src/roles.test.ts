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
  tokenExplicitOnlyActions,
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

test('viewers only read the workspace, repositories, apps, listings, plans, reviews, events, ASO, analytics and alerts', () => {
  const reads = [
    'workspace.read',
    'repositories.read',
    'apps.read',
    'listing.read',
    'plans.read',
    'reviews.read',
    'events.read',
    'aso.read',
    'analytics.read',
    'alerts.read',
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
  for (const action of [
    'tokens.read',
    'tokens.manage',
    'webhooks.read',
    'webhooks.manage',
    'chat.read',
    'chat.manage',
  ] as const) {
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
    for (const role of roles)
      assert.equal(canToken(role, null, action), false, `${role} ${action}`);
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

test('every grantable action is one the admin ceiling can do, those that publish to a store only when named', () => {
  for (const action of tokenActions) {
    assert.equal(
      canToken('admin', null, action),
      !tokenExplicitOnlyActions.includes(action),
      action,
    );
    assert.equal(canToken('admin', [action], action), true, action);
  }
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
  // Replying to a review is a store write with its own action (see docs/api/reviews.md).
  assert.ok(
    !actions.some(
      (a) =>
        /^reviews\./.test(a) &&
        ![
          'reviews.read',
          'reviews.sync',
          'reviews.triage',
          'reviews.reply',
          'reviews.translate',
        ].includes(a),
    ),
  );
  // All three can be given to an API token.
  for (const action of ['reviews.read', 'reviews.sync', 'reviews.triage'] as const) {
    assert.equal(canToken('member', null, action), true, action);
  }
  assert.equal(canToken('viewer', null, 'reviews.triage'), false);
});

test('reviews.reply: owners and admins only; a token needs the action named and an admin ceiling', () => {
  assert.equal(can('owner', 'reviews.reply'), true);
  assert.equal(can('admin', 'reviews.reply'), true);
  assert.equal(can('member', 'reviews.reply'), false);
  assert.equal(can('viewer', 'reviews.reply'), false);
  // Drafting stays with members (reviews.triage).
  assert.equal(can('member', 'reviews.triage'), true);
  assert.ok(tokenActions.includes('reviews.reply'));
  assert.ok(tokenExplicitOnlyActions.includes('reviews.reply'));
  assert.equal(canToken('admin', null, 'reviews.reply'), false, 'no list: never');
  assert.equal(canToken('admin', ['reviews.read'], 'reviews.reply'), false);
  assert.equal(canToken('admin', ['reviews.reply'], 'reviews.reply'), true);
  assert.equal(
    canToken('member', ['reviews.reply'], 'reviews.reply'),
    false,
    'the ceiling still applies',
  );
  assert.equal(canToken('viewer', ['reviews.reply'], 'reviews.reply'), false);
});

test('releases.rollout: owners and admins only; a token needs the action named and an admin ceiling', () => {
  assert.equal(can('owner', 'releases.rollout'), true);
  assert.equal(can('admin', 'releases.rollout'), true);
  assert.equal(can('member', 'releases.rollout'), false);
  assert.equal(can('viewer', 'releases.rollout'), false);
  // Planning the rollout (plans.write) stays with members: it changes nothing in a store.
  assert.equal(can('member', 'plans.write'), true);
  assert.ok(tokenActions.includes('releases.rollout'));
  assert.ok(tokenExplicitOnlyActions.includes('releases.rollout'));
  assert.equal(canToken('admin', null, 'releases.rollout'), false, 'no list: never');
  assert.equal(canToken('admin', ['plans.write'], 'releases.rollout'), false);
  assert.equal(canToken('admin', ['releases.rollout'], 'releases.rollout'), true);
  assert.equal(
    canToken('member', ['releases.rollout'], 'releases.rollout'),
    false,
    'the ceiling still applies',
  );
});

test('settings: members read them, only owners and admins change them; members translate reviews', () => {
  assert.equal(can('viewer', 'settings.read'), false);
  assert.equal(can('member', 'settings.read'), true);
  assert.equal(can('member', 'settings.write'), false);
  assert.equal(can('admin', 'settings.write'), true);
  assert.equal(can('owner', 'settings.write'), true);
  assert.equal(can('viewer', 'reviews.translate'), false);
  assert.equal(can('member', 'reviews.translate'), true);
  assert.equal(can('admin', 'reviews.translate'), true);
});

test('store.push_draft: owners and admins only; a token needs the action named and an admin ceiling', () => {
  assert.equal(can('owner', 'store.push_draft'), true);
  assert.equal(can('admin', 'store.push_draft'), true);
  assert.equal(can('member', 'store.push_draft'), false);
  assert.equal(can('viewer', 'store.push_draft'), false);
  // Staging a change writes nothing to a store: members may (changesets.write), viewers may only read.
  assert.equal(can('member', 'changesets.write'), true);
  assert.ok(tokenActions.includes('store.push_draft'));
  assert.ok(tokenExplicitOnlyActions.includes('store.push_draft'));
  assert.equal(canToken('admin', null, 'store.push_draft'), false, 'no list: never');
  assert.equal(canToken('admin', ['changesets.write'], 'store.push_draft'), false);
  assert.equal(canToken('admin', ['store.push_draft'], 'store.push_draft'), true);
  assert.equal(
    canToken('member', ['store.push_draft'], 'store.push_draft'),
    false,
    'the ceiling still applies',
  );
});

test('store.submit: owners and admins only; a token needs the action named and an admin ceiling', () => {
  assert.equal(can('owner', 'store.submit'), true);
  assert.equal(can('admin', 'store.submit'), true);
  assert.equal(can('member', 'store.submit'), false);
  assert.equal(can('viewer', 'store.submit'), false);
  assert.ok(tokenActions.includes('store.submit'));
  assert.ok(tokenExplicitOnlyActions.includes('store.submit'));
  assert.equal(canToken('admin', null, 'store.submit'), false, 'no list: never');
  assert.equal(
    canToken('admin', ['store.push_draft'], 'store.submit'),
    false,
    'pushing a draft is not submitting',
  );
  assert.equal(canToken('admin', ['store.submit'], 'store.submit'), true);
  assert.equal(
    canToken('member', ['store.submit'], 'store.submit'),
    false,
    'the ceiling still applies',
  );
});

test('ASO: everybody reads, members track keywords and competitors, only admins refresh everything', () => {
  for (const role of ['viewer', 'member', 'admin', 'owner'] as const)
    assert.equal(can(role, 'aso.read'), true, role);
  assert.equal(can('viewer', 'aso.write'), false);
  assert.equal(can('member', 'aso.write'), true);
  assert.equal(can('member', 'aso.manage'), false);
  for (const role of ['admin', 'owner'] as const) {
    assert.equal(can(role, 'aso.write'), true, role);
    assert.equal(can(role, 'aso.manage'), true, role);
  }
  // A token may hold them (they read public store data and write only this server's database).
  assert.equal(canToken('member', null, 'aso.write'), true);
  assert.equal(canToken('viewer', null, 'aso.write'), false);
  assert.equal(canToken('admin', null, 'aso.manage'), true);
});

test('builds.share: owners and admins only; explicit-only on tokens, separate from downloading', () => {
  assert.equal(can('owner', 'builds.share'), true);
  assert.equal(can('admin', 'builds.share'), true);
  assert.equal(
    can('member', 'builds.share'),
    false,
    'a member may download a build but not hand it to Google',
  );
  assert.equal(can('viewer', 'builds.share'), false);
  assert.ok(tokenActions.includes('builds.share'));
  assert.ok(tokenExplicitOnlyActions.includes('builds.share'));
  assert.equal(canToken('admin', null, 'builds.share'), false, 'no list: never');
  assert.equal(canToken('admin', ['builds.download'], 'builds.share'), false);
  assert.equal(canToken('admin', ['builds.share'], 'builds.share'), true);
  assert.equal(
    canToken('member', ['builds.share'], 'builds.share'),
    false,
    'the ceiling still applies',
  );
});

test('store.release: owners and admins only; explicit-only on tokens, separate from submit and rollout', () => {
  assert.equal(can('owner', 'store.release'), true);
  assert.equal(can('admin', 'store.release'), true);
  assert.equal(can('member', 'store.release'), false);
  assert.equal(can('viewer', 'store.release'), false);
  assert.ok(tokenActions.includes('store.release'));
  assert.ok(tokenExplicitOnlyActions.includes('store.release'));
  assert.equal(canToken('admin', null, 'store.release'), false, 'no list: never');
  assert.equal(
    canToken('admin', ['store.submit', 'releases.rollout', 'store.push_draft'], 'store.release'),
    false,
    'submitting, rolling out and pushing are not releasing',
  );
  assert.equal(canToken('admin', ['store.release'], 'store.release'), true);
  assert.equal(
    canToken('member', ['store.release'], 'store.release'),
    false,
    'the ceiling still applies',
  );
});

test('store.publish: owners and admins only; explicit-only on tokens and never a substitute for the rights of the steps', () => {
  assert.equal(can('owner', 'store.publish'), true);
  assert.equal(can('admin', 'store.publish'), true);
  assert.equal(can('member', 'store.publish'), false);
  assert.equal(can('viewer', 'store.publish'), false);
  assert.ok(tokenActions.includes('store.publish'));
  assert.ok(tokenExplicitOnlyActions.includes('store.publish'));
  assert.equal(canToken('admin', null, 'store.publish'), false, 'no list: never');
  for (const step of [
    'store.push_draft',
    'store.submit',
    'store.release',
    'releases.rollout',
  ] as const) {
    assert.equal(
      canToken('admin', ['store.publish'], step),
      false,
      `store.publish does not give ${step}`,
    );
    assert.equal(
      canToken('admin', [step], 'store.publish'),
      false,
      `${step} does not give store.publish`,
    );
  }
  assert.equal(canToken('admin', ['store.publish'], 'store.publish'), true);
  assert.equal(
    canToken('member', ['store.publish'], 'store.publish'),
    false,
    'the ceiling still applies',
  );
});

test('analytics.read: every role; analytics.manage: owners and admins only, explicit-only on tokens', () => {
  for (const role of roles) assert.equal(can(role, 'analytics.read'), true, role);
  assert.equal(can('owner', 'analytics.manage'), true);
  assert.equal(can('admin', 'analytics.manage'), true);
  assert.equal(can('member', 'analytics.manage'), false);
  assert.equal(can('viewer', 'analytics.manage'), false);
  assert.ok(tokenExplicitOnlyActions.includes('analytics.manage'));
  assert.ok(
    !tokenExplicitOnlyActions.includes('analytics.read'),
    'reading is a default token right',
  );
  assert.equal(canToken('admin', null, 'analytics.manage'), false);
  assert.equal(canToken('admin', ['analytics.manage'], 'analytics.manage'), true);
  assert.equal(
    canToken('member', ['analytics.manage'], 'analytics.manage'),
    false,
    'a token never exceeds its role',
  );
  assert.equal(canToken('viewer', null, 'analytics.read'), true);
});

test('monetization.write: owners and admins only; explicit-only on tokens, apart from the rights of every other store write', () => {
  assert.equal(can('owner', 'monetization.write'), true);
  assert.equal(can('admin', 'monetization.write'), true);
  assert.equal(can('member', 'monetization.write'), false);
  assert.equal(can('viewer', 'monetization.write'), false);
  // Reading products and syncing them use the app rights: a member may sync, nobody below admin may write.
  assert.equal(can('member', 'apps.sync'), true);
  assert.ok(tokenActions.includes('monetization.write'));
  assert.ok(tokenExplicitOnlyActions.includes('monetization.write'));
  assert.equal(canToken('admin', null, 'monetization.write'), false, 'no list: never');
  for (const other of ['store.push_draft', 'store.publish', 'releases.rollout'] as const) {
    assert.equal(canToken('admin', [other], 'monetization.write'), false, other);
    assert.equal(canToken('admin', ['monetization.write'], other), false, other);
  }
  assert.equal(canToken('admin', ['monetization.write'], 'monetization.write'), true);
  assert.equal(
    canToken('member', ['monetization.write'], 'monetization.write'),
    false,
    'the ceiling still applies',
  );
});

test('monetization.price: owners and admins only, a separate right from the text write, explicit-only on tokens', () => {
  assert.equal(can('owner', 'monetization.price'), true);
  assert.equal(can('admin', 'monetization.price'), true);
  assert.equal(can('member', 'monetization.price'), false);
  assert.equal(can('viewer', 'monetization.price'), false);
  assert.ok(tokenExplicitOnlyActions.includes('monetization.price'));
  assert.equal(canToken('admin', null, 'monetization.price'), false, 'no list: never');
  assert.equal(
    canToken('admin', ['monetization.write'], 'monetization.price'),
    false,
    'the text right is not the price right',
  );
  assert.equal(canToken('admin', ['monetization.price'], 'monetization.price'), true);
});
