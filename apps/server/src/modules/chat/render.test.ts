import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setMailLinkOrigin } from '../../services/mail-template.ts';
import { retryAfterMs, judge } from './delivery.ts';
import { buildAlertMessage, buildDigest, buildTestMessage } from './message.ts';
import { accentOf, type ChatMessage, hostAllowed, limits } from './model.ts';
import { renderDigest, renderMessage } from './render.ts';
import { escapeMrkdwn, type SlackPayload } from './slack.ts';
import { escapeTeams, type TeamsPayload } from './teams.ts';
import { ruleMatches } from './routing.ts';

const data = {
  appId: 'app1',
  appName: 'Moon *Diary* <!channel> & _co_ `x`',
  platform: 'ios',
  version: '2.0',
  track: '',
  build: '7',
};
const input = (locale: string) => ({
  type: 'release.rejected',
  severity: 'critical' as const,
  title: 'Moon Diary 2.0 was rejected',
  body: 'The store rejected version 2.0.',
  data,
  locale,
});

test('Slack: a Block Kit message in an attachment with an accent colour, inside the documented limits', () => {
  setMailLinkOrigin('https://kiln.example.com');
  const payload = renderMessage('slack', buildAlertMessage(input('en'))) as SlackPayload;
  const [attachment] = payload.attachments;
  assert.ok(attachment);
  assert.equal(attachment.color, accentOf.critical);
  const blocks = attachment.blocks as { type: string; text?: { type: string; text: string }; fields?: { text: string }[]; elements?: { type: string; url?: string; text?: { text: string } }[] }[];
  assert.ok(blocks.length <= limits.slack.blocks);
  assert.equal(blocks[0]?.type, 'header');
  assert.equal(blocks[0]?.text?.type, 'plain_text');
  assert.ok((blocks[0]?.text?.text.length ?? 0) <= limits.slack.header);
  const fields = blocks.find((b) => b.fields)?.fields ?? [];
  assert.ok(fields.length >= 3 && fields.length <= limits.slack.fields);
  for (const f of fields) assert.ok(f.text.length <= limits.slack.fieldText);
  const actions = blocks.find((b) => b.type === 'actions');
  const button = actions?.elements?.[0];
  assert.equal(button?.type, 'button');
  assert.equal(button?.url, 'https://kiln.example.com/#/portfolio/app1/releases');
  assert.ok((button?.text?.text.length ?? 0) <= limits.slack.buttonText);
  // No interactive element: link buttons only, nothing that needs a public endpoint.
  assert.ok(!JSON.stringify(payload).includes('action_id'));
  assert.ok(!/[\u{1F300}-\u{1FAFF}☀-➿]/u.test(JSON.stringify(payload)), 'no emoji');
  JSON.parse(JSON.stringify(payload));
});

test('Slack: dynamic values cannot open a link, a mention or a format', () => {
  setMailLinkOrigin('https://kiln.example.com');
  const text = JSON.stringify(renderMessage('slack', buildAlertMessage(input('en'))));
  assert.ok(!text.includes('<!channel>'), 'a mention must not survive');
  assert.ok(text.includes('&lt;!channel&gt;'));
  assert.ok(text.includes('&amp;'));
  assert.equal(escapeMrkdwn('a <b> & c'), 'a &lt;b&gt; &amp; c');
  const formatted = escapeMrkdwn('*bold* _it_ ~s~ `c`');
  assert.ok(!/(^|[^​])\*[^​]/.test(formatted), 'every formatting character is wrapped in zero-width spaces');
});

test('Teams: an Adaptive Card in a message envelope, escaped, with link buttons and within 28 KB', () => {
  setMailLinkOrigin('https://kiln.example.com');
  const payload = renderMessage('teams', buildAlertMessage(input('en'))) as TeamsPayload;
  assert.equal(payload.type, 'message');
  const [att] = payload.attachments;
  assert.equal(att?.contentType, 'application/vnd.microsoft.card.adaptive');
  const card = att?.content as { type: string; version: string; $schema: string; body: { type: string; facts?: { title: string; value: string }[] }[]; actions?: { type: string; url: string }[] };
  assert.equal(card.type, 'AdaptiveCard');
  assert.equal(card.version, '1.4');
  assert.ok(card.$schema.startsWith('http://adaptivecards.io/'));
  const facts = card.body.find((b) => b.type === 'FactSet')?.facts ?? [];
  const app = facts[0]?.value ?? '';
  assert.ok(app.includes('\\*Diary\\*') && app.includes('\\<\\!channel\\>') && app.includes('\\_co\\_'), app);
  assert.deepEqual(
    (card.actions ?? []).map((a) => [a.type, a.url]),
    [['Action.OpenUrl', 'https://kiln.example.com/#/portfolio/app1/releases']],
  );
  assert.ok(!card.actions?.some((a) => a.type !== 'Action.OpenUrl'), 'no Action.Submit in v1');
  assert.equal(escapeTeams('[x](y) # *a*'), '\\[x\\]\\(y\\) \\# \\*a\\*');
});

test('Teams: a huge body is shortened until the card fits 28 KB; Slack cuts text to its block limits', () => {
  const huge: ChatMessage = {
    severity: 'warning',
    fallback: 'x',
    title: 'T'.repeat(5000),
    severityLabel: 'Needs attention',
    facts: Array.from({ length: 30 }, (_, i) => ({ label: `L${i}`, value: 'v'.repeat(500) })),
    body: 'b'.repeat(200_000),
    buttons: [],
    footer: 'f',
  };
  const teams = renderMessage('teams', huge);
  assert.ok(Buffer.byteLength(JSON.stringify(teams)) <= limits.teams.bytes);
  const slack = renderMessage('slack', huge) as SlackPayload;
  const blocks = slack.attachments[0]?.blocks as { text?: { text: string }; fields?: unknown[] }[];
  assert.ok(blocks.length <= 50);
  assert.ok((blocks[0]?.text?.text.length ?? 0) <= limits.slack.header);
  for (const b of blocks) assert.ok((b.text?.text.length ?? 0) <= limits.slack.sectionText);
  assert.ok((blocks.find((b) => b.fields)?.fields?.length ?? 0) <= limits.slack.fields);
});

test('no link origin: no buttons, and the message says where to go in words', () => {
  setMailLinkOrigin(undefined);
  const m = buildAlertMessage(input('en'));
  assert.deepEqual(m.buttons, []);
  assert.match(m.noLink ?? '', /Open Kiln: .*Moon/);
  const slack = JSON.stringify(renderMessage('slack', m));
  assert.ok(!slack.includes('"actions"'));
  setMailLinkOrigin('https://kiln.example.com');
});

test('the language of the destination is used for every sentence, in all four languages', () => {
  setMailLinkOrigin('https://kiln.example.com');
  const english = buildAlertMessage(input('en'));
  const seen = new Set<string>([english.title]);
  for (const locale of ['fr', 'es', 'de']) {
    const m = buildAlertMessage(input(locale));
    assert.notEqual(m.title, english.title, `${locale} title is translated`);
    assert.notEqual(m.severityLabel, english.severityLabel, locale);
    assert.notEqual(m.hint?.text, english.hint?.text, locale);
    assert.notEqual(m.buttons[0]?.label, english.buttons[0]?.label, locale);
    assert.notEqual(m.facts[0]?.label, 'chat:field.app');
    assert.ok(!JSON.stringify(m).includes('chat:'), `${locale}: a key leaked`);
    assert.ok(!JSON.stringify(m).includes('alerts:'), `${locale}: a key leaked`);
    seen.add(m.title);
    const test = buildTestMessage({ name: 'Team "Releases"', locale });
    assert.notEqual(test.title, buildTestMessage({ name: 'x', locale: 'en' }).title, locale);
    assert.ok(test.body.includes('Team "Releases"'));
  }
  assert.equal(seen.size, 4);
  // An unknown language falls back to English.
  assert.equal(buildAlertMessage(input('xx')).title, english.title);
});

test('the digest: one message, at most 40 items, inside both providers limits', () => {
  setMailLinkOrigin('https://kiln.example.com');
  const items = Array.from({ length: 120 }, (_, i) => ({
    type: 'release.rejected',
    severity: i % 2 ? ('warning' as const) : ('info' as const),
    title: `Title ${i} <!here> *x*`,
    data: { ...data, appName: `App ${i}` },
    count: i % 3 === 0 ? 4 : 1,
  }));
  const digest = buildDigest({ items, total: items.length, locale: 'fr' });
  assert.equal(digest.items.length, 40);
  assert.match(digest.more ?? '', /80/);
  const slack = renderDigest('slack', digest) as SlackPayload;
  assert.ok((slack.attachments[0]?.blocks.length ?? 99) <= limits.slack.blocks);
  assert.ok(!JSON.stringify(slack).includes('<!here>'));
  const teams = renderDigest('teams', digest);
  assert.ok(Buffer.byteLength(JSON.stringify(teams)) <= limits.teams.bytes);
  assert.match(digest.heading, /alertes/);
});

test('hosts: only the providers known domains, unless the admin allows any', () => {
  assert.equal(hostAllowed('slack', 'hooks.slack.com'), true);
  assert.equal(hostAllowed('slack', 'hooks.slack.com.evil.example'), false);
  assert.equal(hostAllowed('slack', 'example.com'), false);
  assert.equal(hostAllowed('teams', 'prod-12.westus.logic.azure.com'), true);
  assert.equal(hostAllowed('teams', 'abc.aa.environment.api.powerplatform.com'), true);
  assert.equal(hostAllowed('teams', 'contoso.webhook.office.com'), true);
  assert.equal(hostAllowed('teams', 'logic.azure.com.evil.example'), false);
  assert.equal(hostAllowed('teams', 'hooks.slack.com'), false);
  assert.equal(hostAllowed('teams', 'evilpowerplatform.com'), false);
});

test('routing rules: types, severity, apps and platforms', () => {
  const alert = { type: 'release.rejected', severity: 'critical' as const, appId: 'a1', platform: 'ios' };
  const rule = { alertTypes: ['*'], minSeverity: 'info' as const, appIds: null, platforms: null };
  assert.equal(ruleMatches(rule, alert), true);
  assert.equal(ruleMatches({ ...rule, alertTypes: ['release.live'] }, alert), false);
  assert.equal(ruleMatches({ ...rule, minSeverity: 'critical' }, { ...alert, severity: 'warning' }), false);
  assert.equal(ruleMatches({ ...rule, appIds: ['a2'] }, alert), false);
  assert.equal(ruleMatches({ ...rule, appIds: ['a1'] }, alert), true);
  assert.equal(ruleMatches({ ...rule, appIds: ['a1'] }, { ...alert, appId: null }), false);
  assert.equal(ruleMatches({ ...rule, platforms: ['android'] }, alert), false);
  assert.equal(ruleMatches({ ...rule, platforms: ['ios', 'macos'] }, alert), true);
});

test('Retry-After and the meaning of an answer', () => {
  assert.equal(retryAfterMs('30', 0), 30_000);
  assert.equal(retryAfterMs('0', 0), 1000, 'at least one second');
  assert.equal(retryAfterMs('99999', 0), 300_000, 'capped at five minutes');
  assert.equal(retryAfterMs(new Date(10_000).toUTCString(), 0), 10_000);
  assert.equal(retryAfterMs('soon', 0), undefined);
  assert.equal(retryAfterMs(undefined, 0), undefined);
  const ok = (status: number, retryAfter?: string) => ({ ok: true as const, status, body: '', ...(retryAfter ? { retryAfter } : {}) });
  assert.deepEqual(judge(ok(200), 0), { kind: 'sent' });
  assert.deepEqual(judge(ok(202), 0), { kind: 'sent' });
  assert.deepEqual(judge(ok(429, '12'), 0), { kind: 'retry', outcome: 'rate_limited', waitMs: 12_000 });
  assert.equal(judge(ok(503), 0).kind, 'retry');
  assert.deepEqual(judge(ok(404), 0), { kind: 'fail', outcome: 'webhook_gone' });
  assert.deepEqual(judge(ok(400), 0), { kind: 'fail', outcome: 'payload_rejected' });
  assert.deepEqual(judge(ok(302), 0), { kind: 'fail', outcome: 'redirected' });
  assert.deepEqual(judge({ ok: false, kind: 'blocked', message: '', transient: false }, 0), { kind: 'fail', outcome: 'blocked_address' });
  assert.deepEqual(judge({ ok: false, kind: 'timeout', message: '', transient: true }, 0), { kind: 'retry', outcome: 'timeout' });
});
