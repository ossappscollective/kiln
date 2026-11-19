import assert from 'node:assert/strict';
import { test } from 'node:test';
import { categoryLabel, describeEvent, eventCategory, eventVisual, timeAgo } from './format.ts';

const now = Date.UTC(2026, 10, 18, 12, 0, 0);

test('timeAgo steps from seconds to a date', () => {
  assert.equal(timeAgo(now - 5_000, now), 'just now');
  assert.equal(timeAgo(now - 60_000, now), '1 minute ago');
  assert.equal(timeAgo(now - 5 * 60_000, now), '5 minutes ago');
  assert.equal(timeAgo(now - 3 * 3_600_000, now), '3 hours ago');
  assert.equal(timeAgo(now - 30 * 3_600_000, now), 'yesterday');
  assert.equal(timeAgo(now - 4 * 86_400_000, now), '4 days ago');
  assert.match(timeAgo(now - 30 * 86_400_000, now, 'en-US'), /Oct/);
});

test('events read as sentences', () => {
  assert.equal(
    describeEvent({
      action: 'credential.create',
      actorType: 'user',
      actorName: 'Ada',
      detail: { label: 'Acme key', kind: 'github_token' },
    }),
    'Ada added a credential “Acme key”',
  );
  assert.equal(
    describeEvent({
      action: 'credential.delete',
      actorType: 'user',
      actorName: null,
      detail: null,
    }),
    'Someone deleted a credential',
  );
  assert.equal(
    describeEvent({
      action: 'credential.use',
      actorType: 'system',
      actorName: null,
      detail: { purpose: 'repo scan' },
    }),
    'System used a credential for repo scan',
  );
  assert.equal(
    describeEvent({
      action: 'future.thing',
      actorType: 'assistant',
      actorName: null,
      detail: null,
    }),
    'Assistant future.thing',
  );
});

test('member and invitation events read as sentences', () => {
  const ev = (
    action: string,
    detail: Record<string, unknown> | null,
    actorName: string | null = 'Ada',
  ) => describeEvent({ action, actorType: 'user', actorName, detail });
  assert.equal(
    ev('invitation.create', { email: 'bob@example.com', role: 'member' }),
    'Ada invited bob@example.com as member',
  );
  assert.equal(
    ev('invitation.accept', { role: 'viewer' }, 'Bob'),
    'Bob joined the workspace as viewer from an invitation',
  );
  assert.equal(
    ev('invitation.revoke', { email: 'bob@example.com' }),
    'Ada revoked the invitation for bob@example.com',
  );
  assert.equal(
    ev('member.role_change', { from: 'member', to: 'admin' }),
    'Ada changed a member’s role from member to admin',
  );
  assert.equal(ev('member.remove', { self: true }), 'Ada left the workspace');
  assert.equal(ev('member.remove', { self: false }), 'Ada removed a member from the workspace');
});

test('initials takes the first and last word', async () => {
  const { initials } = await import('./format.ts');
  assert.equal(initials('Ada Lovelace'), 'AL');
  assert.equal(initials('  grace  brewster murray hopper '), 'GH');
  assert.equal(initials('ada'), 'A');
  assert.equal(initials('   '), '?');
});

test('groupByDay splits at local midnight and labels Today and Yesterday', async () => {
  const { groupByDay, dayLabel, eventCategory, eventVisual } = await import('./format.ts');
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();
  const now = at(18, 15);
  const events = [{ at: at(18, 14) }, { at: at(18, 1) }, { at: at(17, 23) }, { at: at(10, 9) }];
  const groups = groupByDay(events, now, 'en-US');
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.length]),
    [
      ['Today', 2],
      ['Yesterday', 1],
      ['Tue, Nov 10', 1],
    ],
  );
  assert.equal(dayLabel(at(18, 0), now), 'Today');
  assert.equal(eventCategory('credential.create'), 'credential');
  assert.equal(eventCategory('weird'), 'other');
  assert.equal(eventVisual('credential.delete').icon, 'trash');
  assert.equal(eventVisual('something.new').icon, 'history');
});

test('token and webhook actions read as sentences, and a token is named as the actor', () => {
  assert.equal(
    describeEvent({
      action: 'token.create',
      actorType: 'user',
      actorName: 'Ada',
      detail: { name: 'CI', role: 'member' },
    }),
    'Ada made an API token “CI” (member)',
  );
  assert.equal(
    describeEvent({
      action: 'token.revoke',
      actorType: 'user',
      actorName: 'Ada',
      detail: { name: 'CI' },
    }),
    'Ada revoked an API token “CI”',
  );
  assert.equal(
    describeEvent({
      action: 'webhook.update',
      actorType: 'user',
      actorName: 'Ada',
      detail: { changed: ['url', 'enabled'] },
    }),
    'Ada changed a webhook (url, enabled)',
  );
  assert.equal(
    describeEvent({
      action: 'changeset.create',
      actorType: 'token',
      actorName: 'Release CI',
      detail: null,
    }),
    'API token “Release CI” changeset.create',
  );
  assert.equal(
    describeEvent({ action: 'x', actorType: 'system', actorName: null, detail: null }),
    'System x',
  );
  assert.equal(eventCategory('webhook.create'), 'webhook');
  assert.equal(categoryLabel('token'), 'API tokens');
  assert.deepEqual(eventVisual('webhook.create'), { icon: 'globe', tone: 'ok' });
  assert.deepEqual(eventVisual('token.revoke'), { icon: 'trash', tone: 'bad' });
});
