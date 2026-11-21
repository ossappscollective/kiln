import assert from 'node:assert/strict';
import { test } from 'node:test';
import { can, tokenForbiddenActions } from '@kiln/core';
import {
  actionLabel,
  ceilingsFor,
  createInput,
  curlExample,
  expiryFor,
  expiryLabel,
  lastUsed,
  narrowableActions,
  orderTokens,
  scopeSummary,
  tokenStatus,
  validateTokenForm,
} from './api-tokens.ts';
import type { ApiToken } from './types.ts';

const now = Date.UTC(2026, 10, 18, 12, 0, 0);
const DAY = 24 * 3600_000;

const token = (over: Partial<ApiToken> = {}): ApiToken => ({
  id: 't1',
  name: 'CI',
  prefix: 'kiln_abcdef',
  role: 'member',
  appIds: null,
  actions: null,
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
  createdAt: now - DAY,
  createdBy: { id: 'u1', name: 'Ada' },
  status: 'active',
  ...over,
});

test('a person can hand out ceilings up to their own role, and never owner', () => {
  assert.deepEqual(ceilingsFor('owner'), ['viewer', 'member', 'admin']);
  assert.deepEqual(ceilingsFor('admin'), ['viewer', 'member', 'admin']);
  assert.deepEqual(ceilingsFor('member'), ['viewer', 'member']);
  assert.deepEqual(ceilingsFor('viewer'), ['viewer']);
});

test('expiry choices become a time in the future, or none', () => {
  assert.equal(expiryFor('never', now), undefined);
  assert.equal(expiryFor('30d', now), now + 30 * DAY);
  assert.equal(expiryFor('90d', now), now + 90 * DAY);
  assert.equal(expiryFor('1y', now), now + 365 * DAY);
});

test('the actions a token can be narrowed to never include what tokens may not hold', () => {
  for (const role of ['viewer', 'member', 'admin'] as const) {
    const list = narrowableActions(role);
    assert.ok(list.length > 0);
    for (const action of list) {
      assert.equal(can(role, action), true, `${role} ${action}`);
      assert.equal(tokenForbiddenActions.includes(action), false, action);
    }
  }
  assert.equal(narrowableActions('viewer').includes('apps.sync'), false);
  assert.equal(narrowableActions('member').includes('apps.sync'), true);
  assert.equal(narrowableActions('admin').includes('tokens.manage'), false);
  assert.equal(narrowableActions('admin').includes('credentials.write'), false);
});

test('action labels read as a short phrase', () => {
  assert.equal(actionLabel('apps.read'), 'Read apps');
  assert.equal(actionLabel('changesets.approve'), 'Approve and apply changesets');
  assert.equal(actionLabel('ci.dispatch'), 'Start ci');
  assert.equal(actionLabel('listing.read'), 'Read listing');
});

const form = (over = {}) => ({
  name: 'CI',
  role: 'member' as const,
  expiry: '90d' as const,
  appIds: [],
  actions: [],
  ...over,
});

test('the form needs a name and only allowed actions', () => {
  assert.deepEqual(validateTokenForm(form()), {});
  assert.ok(validateTokenForm(form({ name: '   ' })).name);
  assert.ok(validateTokenForm(form({ name: 'x'.repeat(101) })).name);
  assert.ok(validateTokenForm(form({ role: 'viewer', actions: ['apps.sync'] })).actions);
  assert.ok(validateTokenForm(form({ actions: ['tokens.manage'] })).actions);
  assert.deepEqual(validateTokenForm(form({ actions: ['apps.read', 'apps.sync'] })), {});
});

test('the request leaves out every limit that is not set, and trims and de-duplicates', () => {
  assert.deepEqual(createInput(form({ name: ' CI ', expiry: 'never' }), now), {
    name: 'CI',
    role: 'member',
  });
  assert.deepEqual(
    createInput(
      form({ appIds: ['a', 'a', 'b'], actions: ['apps.read', 'apps.read'], expiry: '30d' }),
      now,
    ),
    {
      name: 'CI',
      role: 'member',
      appIds: ['a', 'b'],
      actions: ['apps.read'],
      expiresAt: now + 30 * DAY,
    },
  );
});

test('status: active, expires soon, expired and revoked each say so in words', () => {
  assert.equal(tokenStatus(token(), now).label, 'Active');
  assert.equal(tokenStatus(token({ expiresAt: now + 30 * DAY }), now).label, 'Active');
  assert.equal(tokenStatus(token({ expiresAt: now + 2 * DAY }), now).label, 'Expires soon');
  assert.equal(
    tokenStatus(token({ status: 'expired', expiresAt: now - DAY }), now).label,
    'Expired',
  );
  assert.equal(
    tokenStatus(token({ status: 'revoked', revokedAt: now - 1000 }), now).label,
    'Revoked',
  );
  assert.equal(tokenStatus(token({ status: 'revoked' }), now).tone, 'neutral');
});

test('last used and expiry read naturally', () => {
  assert.equal(lastUsed(token(), now), 'Never used');
  assert.equal(lastUsed(token({ lastUsedAt: now - 5 * 60_000 }), now), '5 minutes ago');
  assert.equal(expiryLabel(token(), now), 'Never');
  assert.equal(expiryLabel(token({ expiresAt: now + 10 * DAY }), now), 'In 10 days');
  assert.equal(expiryLabel(token({ expiresAt: now + 3600_000 }), now), 'In under a day');
  assert.match(expiryLabel(token({ expiresAt: now - 3 * 3600_000 }), now), /^Expired 3 hours ago$/);
});

test('scope says what the token is limited to', () => {
  assert.equal(scopeSummary(token()), 'All apps · all actions of the role');
  assert.equal(
    scopeSummary(token({ appIds: ['a'], actions: ['apps.read', 'apps.sync'] })),
    '1 app · 2 actions',
  );
  assert.equal(
    scopeSummary(token({ appIds: ['a', 'b'], actions: ['apps.read'] })),
    '2 apps · 1 action',
  );
});

test('the curl example keeps the token in a header, never in the URL', () => {
  const text = curlExample('https://kiln.example.com/', 'w1', 'kiln_secret');
  assert.equal(
    text,
    'curl -H "Authorization: Bearer kiln_secret" \\\n  https://kiln.example.com/api/workspaces/w1/apps',
  );
  assert.equal(text.split('\n')[1]?.includes('kiln_secret'), false);
});

test('usable tokens come first, newest first within each group', () => {
  const list = [
    token({ id: 'old-revoked', status: 'revoked', createdAt: 5 }),
    token({ id: 'old', createdAt: 1 }),
    token({ id: 'new', createdAt: 9 }),
    token({ id: 'expired', status: 'expired', createdAt: 8 }),
  ];
  assert.deepEqual(
    orderTokens(list).map((t) => t.id),
    ['new', 'old', 'expired', 'old-revoked'],
  );
  assert.equal(list[0]?.id, 'old-revoked', 'the input is not changed');
});
