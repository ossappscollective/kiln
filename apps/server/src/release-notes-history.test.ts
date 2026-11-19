import assert from 'node:assert/strict';
import { StoreError } from '@mrm/connectors';
import { dbTest } from '@mrm/db/testing';
import { clearNotesHistoryCache } from './services/notes-history.ts';
import { bootStaged } from './staged-test-helpers.ts';

/**
 * The notes history of an app (docs/api/releases-write.md, "Notes history") and the verdict and TestFlight notes that the
 * release candidates read now carries. The store is a fake; the texts are checked never to reach a log or the audit trail.
 */

// biome-ignore lint/suspicious/noExplicitAny: responses are inspected loosely
type Json = Record<string, any>;

const entry = (
  version: string,
  locale: string,
  text: string,
  at: number | null,
  over: Json = {},
) => ({
  source: 'appstoreconnect' as const,
  locale,
  text,
  truncated: false,
  version,
  track: null,
  state: 'READY_FOR_DISTRIBUTION',
  at,
  ...over,
});
const history = (t: Awaited<ReturnType<typeof bootStaged>>, app: string, query = '') =>
  t.call(t.owner, 'GET', `/apps/${app}/release/notes-history${query}`);

dbTest(
  'notes history: the store and the plans merged, one entry per text, newest first, with every place it was used',
  async (db) => {
    clearNotesHistoryCache();
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    t.stores.ios.notesHistory = {
      entries: [
        entry('2.0', 'en-US', 'Bug fixes', 3000),
        entry('2.0', 'de-DE', 'Fehlerbehebungen', 3000),
        entry('1.5', 'en-US', 'Dark mode', 2000),
        entry('1.0', 'en-US', 'Bug fixes\r\n', 1000), // the same text as 2.0, with a line end
      ],
      truncated: true,
      versionsRead: 3,
      failed: 1,
    };
    // A plan of this app has a note too (the same text as 1.5, written later).
    const plan = await t.call(t.owner, 'POST', `/apps/${app}/plans`, { version: '2.1' });
    const planId = plan.body.plan.id as string;
    const note = await t.call(t.owner, 'PUT', `/apps/${app}/plans/${planId}/notes/en-US`, {
      text: 'Dark mode',
    });
    assert.equal(note.status, 200, note.text);

    const res = await history(t, app);
    assert.equal(res.status, 200, res.text);
    const h = res.body.history as Json;
    assert.deepEqual(h.app, { id: app, platform: 'ios', store: 'appstoreconnect' });
    assert.equal(h.locale, null);
    assert.deepEqual(
      h.notes.map((n: Json) => n.text),
      ['Dark mode', 'Bug fixes', 'Fehlerbehebungen'],
      'newest use first: the plan wrote Dark mode last',
    );
    const dark = h.notes[0] as Json;
    assert.deepEqual(
      dark.uses.map((u: Json) => [u.source, u.version]),
      [
        ['plan', '2.1'],
        ['appstoreconnect', '1.5'],
      ],
    );
    assert.equal(dark.lastUsedAt, dark.uses[0].at);
    const fixes = h.notes[1] as Json;
    assert.deepEqual(
      fixes.uses.map((u: Json) => [u.version, u.at]),
      [
        ['2.0', 3000],
        ['1.0', 1000],
      ],
      'two versions, one text',
    );
    assert.deepEqual(fixes.locales, ['en-US']);
    assert.equal(fixes.text, 'Bug fixes');
    assert.deepEqual(h.store, {
      read: true,
      error: null,
      cached: false,
      versionsRead: 3,
      failed: 1,
      truncated: true,
    });
    assert.equal(h.truncated, false);
    assert.equal(h.limit, 30);

    // Cached: the store is not asked again, and the answer says so.
    const again = (await history(t, app)).body.history as Json;
    assert.equal(again.store.cached, true);
    assert.equal(t.stores.ios.notesHistoryReads, 1);
    // A language narrows the read and is a different cache entry.
    const de = (await history(t, app, '?locale=de_DE')).body.history as Json;
    assert.deepEqual(
      de.notes.map((n: Json) => n.text),
      ['Fehlerbehebungen'],
    );
    assert.deepEqual(t.stores.ios.notesHistoryLocales, [undefined, 'de_DE']);
    // limit
    const one = (await history(t, app, '?limit=1')).body.history as Json;
    assert.equal(one.notes.length, 1);
    assert.equal(one.truncated, true);
  },
);

dbTest('notes history: a read is audited as a credential use without the text', async (db) => {
  clearNotesHistoryCache();
  const t = await bootStaged(db);
  const app = await t.addApp('ios');
  t.stores.ios.notesHistory = {
    entries: [entry('2.0', 'en-US', 'SECRET-NOTES-TEXT', 1)],
    truncated: false,
    versionsRead: 1,
    failed: 0,
  };
  assert.equal((await history(t, app)).status, 200);
  const audits = await t.audit();
  const uses = audits.filter(
    (a) => a.action === 'credential.use' && a.detail.purpose === 'store.release_read',
  );
  assert.equal(uses.length, 1);
  assert.ok(!JSON.stringify(audits).includes('SECRET-NOTES-TEXT'), 'no text in the audit trail');
  assert.ok(!JSON.stringify(await t.events()).includes('SECRET-NOTES-TEXT'), 'no text in an event');
});

dbTest(
  'notes history: a failed store read still answers with the plans; one store refusal is a code, not a crash',
  async (db) => {
    clearNotesHistoryCache();
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const plan = await t.call(t.owner, 'POST', `/apps/${app}/plans`, { version: '2.1' });
    await t.call(t.owner, 'PUT', `/apps/${app}/plans/${plan.body.plan.id}/notes/en-US`, {
      text: 'From the plan',
    });
    t.stores.ios.notesHistoryError = new StoreError(
      'appstoreconnect',
      'forbidden',
      'Apple refused (403) SECRET-DETAIL',
      403,
    );
    const res = await history(t, app);
    assert.equal(res.status, 200);
    const h = res.body.history as Json;
    assert.equal(h.store.read, false);
    assert.equal(h.store.error, 'store_forbidden');
    assert.deepEqual(
      h.notes.map((n: Json) => n.text),
      ['From the plan'],
    );
    assert.ok(!res.text.includes('SECRET-DETAIL'));
    // A failure is not cached: when the store answers again, the next read shows it.
    t.stores.ios.notesHistoryError = undefined;
    t.stores.ios.notesHistory = {
      entries: [entry('2.0', 'en-US', 'Back again', 5)],
      truncated: false,
      versionsRead: 1,
      failed: 0,
    };
    assert.equal(((await history(t, app)).body.history as Json).store.read, true);
  },
);

dbTest(
  'notes history: Google Play entries have a track and no date and follow the dated ones',
  async (db) => {
    clearNotesHistoryCache();
    const t = await bootStaged(db);
    const app = await t.addApp('android');
    t.stores.android.notesHistory = {
      entries: [
        {
          source: 'googleplay',
          locale: 'en-US',
          text: 'Beta text',
          truncated: false,
          version: '2.1',
          track: 'beta',
          state: 'inProgress',
          at: null,
        },
        {
          source: 'googleplay',
          locale: 'en-US',
          text: 'Production text',
          truncated: false,
          version: '2.0',
          track: 'production',
          state: 'completed',
          at: null,
        },
      ],
      truncated: false,
      versionsRead: 2,
      failed: 0,
    };
    const plan = await t.call(t.owner, 'POST', `/apps/${app}/plans`, { version: '2.2' });
    await t.call(t.owner, 'PUT', `/apps/${app}/plans/${plan.body.plan.id}/notes/en-US`, {
      text: 'Plan text',
    });
    const h = (await history(t, app)).body.history as Json;
    assert.deepEqual(h.app, { id: app, platform: 'android', store: 'googleplay' });
    assert.deepEqual(
      h.notes.map((n: Json) => n.text),
      ['Plan text', 'Beta text', 'Production text'],
    );
    assert.deepEqual(
      [h.notes[1].uses[0].track, h.notes[1].uses[0].at, h.notes[1].lastUsedAt],
      ['beta', null, null],
    );
  },
);

dbTest(
  'notes history: validation, rights, outsiders, and only a read that reaches the store counts against the limit',
  async (db) => {
    clearNotesHistoryCache();
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    for (const q of [
      '?limit=0',
      '?limit=101',
      '?limit=x',
      '?locale=%3Cb%3E',
      '?platform=windows',
    ]) {
      assert.equal((await history(t, app, q)).status, 400, q);
    }
    const mismatch = await history(t, app, '?platform=android');
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.body.error, 'platform_mismatch');
    assert.equal((await history(t, app, '?platform=ios')).status, 200);
    assert.equal((await history(t, 'no-such-app')).status, 404);
    const viewer = await t.addMember('viewer');
    assert.equal((await t.call(viewer, 'GET', `/apps/${app}/release/notes-history`)).status, 200);
    await db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
    const outsider = await t.addMember('owner', 'other');
    assert.equal((await t.call(outsider, 'GET', `/apps/${app}/release/notes-history`)).status, 404);

    // Thirty store reads a minute (one was used above); the cached ones are free.
    clearNotesHistoryCache();
    const before = t.stores.ios.notesHistoryReads;
    const many = [
      'aa',
      'ab',
      'ac',
      'ad',
      'ae',
      'af',
      'ag',
      'ah',
      'ai',
      'aj',
      'ak',
      'al',
      'am',
      'an',
      'ao',
      'ap',
      'aq',
      'ar',
      'as',
      'at',
      'au',
      'av',
      'aw',
      'ax',
      'ay',
      'az',
      'ba',
      'bb',
      'bc',
    ];
    for (const l of many)
      assert.equal(
        ((await history(t, app, `?locale=${l}`)).body.history as Json).store.error,
        null,
        l,
      );
    const over = await history(t, app, '?locale=be');
    assert.equal(over.status, 200);
    assert.equal((over.body.history as Json).store.error, 'rate_limited');
    assert.ok(Number(over.headers.get('retry-after')) > 0);
    assert.equal(
      (await history(t, app, '?locale=aa')).body.history.store.error,
      null,
      'a cached language is still answered',
    );
    assert.ok(t.stores.ios.notesHistoryReads - before <= 30);
  },
);

dbTest(
  'release candidates: every build has a verdict, the export compliance and the TestFlight notes; every code a verdict',
  async (db) => {
    const t = await bootStaged(db, { draft: { enabled: false }, release: { enabled: false } });
    const app = await t.addApp('ios');
    const droid = await t.addApp('android');
    const ios = (await t.call(t.owner, 'GET', `/apps/${app}/release/candidates`)).body
      .candidates as Json;
    const build = ios.builds[0] as Json;
    assert.deepEqual(Object.keys(build.eligibility).sort(), [
      'code',
      'eligible',
      'message',
      'severity',
    ]);
    assert.equal(build.eligibility.eligible, true);
    assert.equal(build.exportCompliance, 'unknown');
    assert.deepEqual(
      build.testNotes.locales.map((l: Json) => l.locale),
      ['en-US'],
    );
    const play = (
      await t.call(t.owner, 'GET', `/apps/${droid}/release/candidates?track=production`)
    ).body.candidates as Json;
    assert.equal(play.codes[0].eligibility.code, 'ok');
  },
);

dbTest(
  'release candidates: the TestFlight notes are not written to the audit trail or an event',
  async (db) => {
    const t = await bootStaged(db);
    const app = await t.addApp('ios');
    const store = t.stores.ios;
    store.candidates = {
      store: 'appstoreconnect',
      platform: 'ios',
      version: { id: 'v-next', versionString: '2.1', state: 'PREPARE_FOR_SUBMISSION' },
      builds: [
        {
          id: 'b-2',
          buildNumber: '58',
          version: '2.1',
          uploadedDate: null,
          processingState: 'VALID',
          expired: false,
          selectable: true,
          reason: null,
          attached: false,
          eligibility: {
            eligible: true,
            severity: 'ok',
            code: 'ok',
            message: 'Build 58 is processed and can be attached to version 2.1.',
          },
          exportCompliance: 'unknown',
          testNotes: {
            read: true,
            locales: [{ locale: 'en-US', text: 'SECRET-TEST-NOTE', truncated: false }],
          },
        },
      ],
      attachedBuildId: null,
      truncatedAt: null,
    };
    const res = await t.call(t.owner, 'GET', `/apps/${app}/release/candidates`);
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('SECRET-TEST-NOTE'), 'the caller gets the text');
    assert.ok(!JSON.stringify(await t.audit()).includes('SECRET-TEST-NOTE'));
    assert.ok(!JSON.stringify(await t.events()).includes('SECRET-TEST-NOTE'));
  },
);
