import assert from 'node:assert/strict';
import { test } from 'node:test';
import { StoreError } from '../errors.ts';
import * as fx from '../store.fixtures.ts';
import { crashSignature } from '../testflight-crash.ts';
import * as tf from '../testflight-feedback.fixtures.ts';
import {
  AppleTestFlightFeedbackConnector,
  parseSubmission,
} from './appstore-testflight-feedback.ts';

const key = fx.appleKeyPem();

function connector(fake: fx.FakeFetch, extra: Record<string, unknown> = {}) {
  return new AppleTestFlightFeedbackConnector({
    credential: { keyId: fx.KEY_ID, issuerId: fx.ISSUER_ID, privateKey: key.privateKey },
    appStoreId: tf.APP,
    fetch: fake.fetch,
    now: () => tf.T0,
    sleep: async () => undefined,
    ...extra,
  });
}

test('listFeedback reads screenshot feedback and crashes with build number and version; the other platform and broken rows are left out', async () => {
  const fake = tf.feedbackFake();
  // b2 is only on a Mac submission, so its version is never asked.
  const result = await connector(fake).listFeedback();
  assert.deepEqual(fake.unexpected, []);
  assert.equal(result.complete, true);
  assert.equal(result.feedbackRead && result.crashesRead, true);
  assert.deepEqual(
    result.items.map((i) => i.id),
    ['f1', 'f3', 'c1'],
  );
  const [f1, f3, c1] = result.items;
  assert.equal(f1?.kind, 'feedback');
  assert.equal(f1?.buildNumber, '42');
  assert.equal(f1?.version, '2.5.0');
  assert.equal(f1?.createdAt, Date.UTC(2026, 10, 20, 9, 30));
  assert.equal(f1?.email, 'tester@example.com');
  assert.equal(f1?.deviceModel, 'iPhone16,2');
  assert.equal(f1?.connectionType, 'WIFI');
  assert.equal(f1?.appUptimeMs, 61_000);
  assert.deepEqual(f1?.screenshots, [
    { width: 1290, height: 2796 },
    { width: 1290, height: 2796 },
  ]);
  // Never a link in what is kept.
  assert.ok(!JSON.stringify(f1).includes('example.invalid'));
  assert.equal(f3?.buildNumber, null);
  assert.equal(f3?.createdAt, null);
  assert.equal(f3?.email, null);
  assert.equal(c1?.kind, 'crash');
  assert.deepEqual(c1?.screenshots, []);
  assert.equal(c1?.version, '2.5.0');
  // The query carries the platform filter.
  assert.ok(fake.calls.some((c) => c.url.search.includes('filter[appPlatform]=IOS')));
});

test('a Mac record asks for MAC_OS', async () => {
  const fake = new fx.FakeFetch()
    .on({
      method: 'GET',
      match: /betaFeedbackScreenshotSubmissions\?.*filter\[appPlatform\]=MAC_OS/,
      json: { data: [tf.screenshotSubmission('m1', null, { appPlatform: 'MAC_OS' })] },
    })
    .on({
      method: 'GET',
      match: /betaFeedbackCrashSubmissions\?.*filter\[appPlatform\]=MAC_OS/,
      json: { data: [] },
    });
  const result = await connector(fake, { scope: 'macos' }).listFeedback();
  assert.deepEqual(
    result.items.map((i) => i.id),
    ['m1'],
  );
});

test('an empty app is an empty read, not an error', async () => {
  const fake = new fx.FakeFetch()
    .on({ method: 'GET', match: tf.FEEDBACK_LIST, json: { data: [] } })
    .on({ method: 'GET', match: tf.CRASH_LIST, json: { data: [] } });
  const result = await connector(fake).listFeedback();
  assert.deepEqual(result.items, []);
  assert.equal(result.feedbackRead && result.crashesRead, true);
});

test('a refused list is a warning; both refused throws; another failure fails the read', async () => {
  const one = new fx.FakeFetch()
    .on({
      method: 'GET',
      match: tf.FEEDBACK_LIST,
      status: 403,
      json: { errors: [{ status: '403', code: 'FORBIDDEN', title: 'Forbidden' }] },
    })
    .on({ method: 'GET', match: tf.CRASH_LIST, json: { data: [tf.crashSubmission('c1', null)] } });
  const partial = await connector(one).listFeedback();
  assert.equal(partial.feedbackRead, false);
  assert.equal(partial.crashesRead, true);
  assert.equal(partial.warnings.length, 1);
  assert.deepEqual(
    partial.items.map((i) => i.id),
    ['c1'],
  );

  const both = new fx.FakeFetch()
    .on({ method: 'GET', match: tf.FEEDBACK_LIST, status: 404, json: { errors: [] } })
    .on({ method: 'GET', match: tf.CRASH_LIST, status: 404, json: { errors: [] } });
  await assert.rejects(
    connector(both).listFeedback(),
    (e: unknown) => e instanceof StoreError && e.kind === 'not_found',
  );

  const broken = new fx.FakeFetch()
    .on({ method: 'GET', match: tf.FEEDBACK_LIST, status: 500, json: {} })
    .on({ method: 'GET', match: tf.CRASH_LIST, json: { data: [] } });
  await assert.rejects(connector(broken, { maxRateLimitRetries: 0 }).listFeedback());
});

test('a list that has more pages than the cap is partial and says so', async () => {
  const fake = new fx.FakeFetch()
    .on({
      method: 'GET',
      match: tf.FEEDBACK_LIST,
      json: {
        data: [tf.screenshotSubmission('f1', null)],
        links: {
          next: `https://api.appstoreconnect.apple.com/v1/apps/${tf.APP}/betaFeedbackScreenshotSubmissions?cursor=2`,
        },
      },
    })
    .on({ method: 'GET', match: tf.CRASH_LIST, json: { data: [] } });
  const result = await connector(fake, { maxPages: 1 }).listFeedback();
  assert.equal(result.complete, false);
  assert.match(result.warnings.join(' '), /cut at its limit/);
});

test('a version that cannot be read stays null', async () => {
  const fake = tf
    .feedbackFake()
    .on({
      method: 'GET',
      match: '/v1/builds/b9/preReleaseVersion?fields[preReleaseVersions]=version,platform',
      status: 404,
      json: { errors: [] },
    });
  fake.clear('GET', tf.FEEDBACK_LIST);
  fake.on({
    method: 'GET',
    match: tf.FEEDBACK_LIST,
    json: { data: [tf.screenshotSubmission('f9', 'b9')], included: [tf.build('b9', '7')] },
  });
  const result = await connector(fake).listFeedback();
  const f9 = result.items.find((i) => i.id === 'f9');
  assert.equal(f9?.buildNumber, '7');
  assert.equal(f9?.version, null);
});

test('readCrashLog returns the text, or null when the log is gone or has none', async () => {
  const fake = new fx.FakeFetch()
    .on({
      method: 'GET',
      match: '/v1/betaFeedbackCrashSubmissions/c1/crashLog?fields[betaCrashLogs]=logText',
      json: { data: { type: 'betaCrashLogs', id: 'l1', attributes: { logText: tf.CRASH_LOG } } },
    })
    .on({
      method: 'GET',
      match: '/v1/betaFeedbackCrashSubmissions/c2/crashLog?fields[betaCrashLogs]=logText',
      status: 404,
      json: { errors: [] },
    })
    .on({
      method: 'GET',
      match: '/v1/betaFeedbackCrashSubmissions/c3/crashLog?fields[betaCrashLogs]=logText',
      json: { data: { type: 'betaCrashLogs', id: 'l3', attributes: {} } },
    });
  const c = connector(fake);
  assert.equal(await c.readCrashLog('c1'), tf.CRASH_LOG);
  assert.equal(await c.readCrashLog('c2'), null);
  assert.equal(await c.readCrashLog('c3'), null);
});

test('readScreenshots hands on https links with their size and expiry, and nothing else', async () => {
  const fake = new fx.FakeFetch().on({
    method: 'GET',
    match:
      '/v1/betaFeedbackScreenshotSubmissions/f1?fields[betaFeedbackScreenshotSubmissions]=screenshots',
    json: {
      data: {
        type: 'betaFeedbackScreenshotSubmissions',
        id: 'f1',
        attributes: {
          screenshots: [
            {
              url: 'https://example.invalid/a.png',
              width: 10,
              height: 20,
              expirationDate: '2026-11-22T13:00:00Z',
            },
            { url: 'http://example.invalid/insecure.png' },
            { url: 'javascript:alert(1)' },
            { width: 1 },
          ],
        },
      },
    },
  });
  const links = await connector(fake).readScreenshots('f1');
  assert.deepEqual(links, [
    {
      url: 'https://example.invalid/a.png',
      width: 10,
      height: 20,
      expiresAt: Date.UTC(2026, 10, 22, 13),
    },
  ]);
});

test('parseSubmission tolerates a submission with almost nothing in it', () => {
  const parsed = parseSubmission('crash', { id: 'x' }, new Map());
  assert.equal(parsed?.id, 'x');
  assert.equal(parsed?.comment, '');
  assert.equal(parsed?.deviceModel, null);
  assert.equal(parseSubmission('crash', { attributes: {} }, new Map()), null);
});

test('the signature of a symbolicated log is its exception and top frame, without offsets, files or addresses', () => {
  const sig = crashSignature(tf.CRASH_LOG);
  assert.equal(sig?.exception, 'EXC_BAD_ACCESS (SIGSEGV)');
  assert.equal(sig?.frame, 'Example -[SettingsViewController reload]');
  assert.equal(sig?.symbolicated, true);
  assert.equal(sig?.key, 'EXC_BAD_ACCESS (SIGSEGV) | Example -[SettingsViewController reload]');
});

test('an unsymbolicated top frame is the image alone and says so', () => {
  const sig = crashSignature(tf.UNSYMBOLICATED_LOG);
  assert.equal(sig?.frame, 'Example');
  assert.equal(sig?.symbolicated, false);
  assert.equal(sig?.key, 'EXC_BREAKPOINT (SIGTRAP) | Example');
});

test('a log in another layout has no signature (or only an exception)', () => {
  assert.equal(crashSignature(''), null);
  assert.equal(crashSignature('{"json":"crash report"}'), null);
  assert.equal(crashSignature('nothing useful here\n'), null);
  const only = crashSignature('Exception Type: EXC_CRASH (SIGABRT)\n');
  assert.equal(only?.key, 'EXC_CRASH (SIGABRT) | unknown');
  assert.equal(only?.symbolicated, null);
});

test('the same crash on two builds has the same signature', () => {
  assert.equal(
    crashSignature(tf.CRASH_LOG.replace('1234', '99'))?.key,
    crashSignature(tf.CRASH_LOG)?.key,
  );
});
