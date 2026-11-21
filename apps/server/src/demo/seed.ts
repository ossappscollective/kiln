import { randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@kiln/db';
import type { Hono } from 'hono';
import type { AppEnv } from '../http.ts';
import { seedAlertRules, seedAlerts } from './alerts.ts';
import { DEMO_WORKSPACE_NAME } from './config.ts';
import { COMPETITORS, DEMO_APPS, type DemoApp, KEYWORDS, type Platform } from './content.ts';
import { REPO } from './repo.ts';
import { DEMO_USERS } from './routes.ts';
import type { DemoWorld } from './world.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;

const PEM =
  '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDEMOKEYNOTREALDEMOKEYNOTREAL\n-----END PRIVATE KEY-----';
const ASC_SECRET = JSON.stringify({
  keyId: 'DEMOKEY123',
  issuerId: '00000000-demo-0000-0000-000000000000',
  privateKey: PEM,
});
const PLAY_SECRET = JSON.stringify({
  client_email: 'demo-bot@demo-project.iam.gserviceaccount.com',
  private_key: PEM,
});
const GITHUB_TOKEN = 'ghp_demoDEMOdemoDEMOdemoDEMOdemoDEMO0000';

type Json = Record<string, any>;
type Res = { status: number; body: Json; text: string };

export type SeedResult = { workspaceId: string; warnings: string[]; apps: Record<string, string> };

/** Seeds the Demo Studio workspace through the app's own HTTP API, with a simulated clock so history looks lived in. */
/** The Google Play "search terms" export: a month of terms, deterministic. */
function playSearchTermsCsv(key: DemoApp['key'], now: number): Uint8Array {
  const def = DEMO_APPS.find((a) => a.key === key) as DemoApp;
  const terms = KEYWORDS[key]
    .filter((k) => k.country === 'us')
    .map((k) => k.term)
    .concat(['Other']);
  const rows = [
    'Date,Package name,Traffic source,Search term,Store listing acquisitions,Store listing visitors,Store listing conversion rate',
  ];
  for (let d = 30; d >= 1; d -= 1) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    terms.forEach((term, i) => {
      const visitors = 20 + ((d * 7 + i * 13) % 60) + (terms.length - i) * 6;
      const acquisitions = Math.round(visitors * (0.07 + ((d + i) % 5) * 0.015));
      rows.push(
        [
          day,
          def.identifier,
          'Google Play search',
          term,
          acquisitions,
          visitors,
          (acquisitions / visitors).toFixed(4),
        ].join(','),
      );
    });
  }
  return new TextEncoder().encode(`${rows.join('\n')}\n`);
}

export async function seedDemo(input: {
  app: Hono<AppEnv>;
  db: Database;
  world: DemoWorld;
  log?: (m: string) => void;
}): Promise<SeedResult> {
  const { app, db, world } = input;
  const log = input.log ?? (() => {});
  const T = world.seededAt;
  const warnings: string[] = [];
  const at = (daysAgo: number, hours = 0) => {
    world.virtualNow = T - daysAgo * DAY + hours * HOUR;
  };

  const raw = async (
    method: string,
    path: string,
    cookie: string,
    body?: unknown,
    file?: Uint8Array,
  ): Promise<Res> => {
    const res = await app.request(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(file ? { 'content-type': 'text/csv' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(file ? { body: file } : body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: Json = {};
    try {
      parsed = text ? (JSON.parse(text) as Json) : {};
    } catch {
      /* not json */
    }
    return {
      status: res.status,
      body: parsed,
      text,
      ...({ headers: res.headers } as object),
    } as Res;
  };

  // ---- the owner and the workspace -----------------------------------------------------------------------------------------
  at(90);
  const reg = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The owner never signs in with this password: the demo login makes the session. It is random and thrown away.
    body: JSON.stringify({
      email: DEMO_USERS[0].email,
      displayName: DEMO_USERS[0].name,
      password: `${randomBytes(18).toString('base64')}aA1`,
      workspaceName: DEMO_WORKSPACE_NAME,
    }),
  });
  if (reg.status !== 201 && reg.status !== 200)
    throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
  const cookie = reg.headers.get('set-cookie')?.split(';')[0] ?? '';
  const workspaceId = ((await reg.json()) as { workspaceId: string }).workspaceId;
  // The seed walks through simulated past days: keep its own session valid for all of them.
  await input.db.execute('UPDATE sessions SET expires_at = ?', [T + 400 * DAY]);
  const W = `/api/workspaces/${workspaceId}`;
  const call = (method: string, path: string, body?: unknown, c = cookie) =>
    raw(method, `${W}${path}`, c, body);
  const must = async (what: string, p: Promise<Res>): Promise<Json> => {
    const r = await p;
    if (r.status >= 300) throw new Error(`${what}: ${r.status} ${r.text.slice(0, 400)}`);
    return r.body;
  };
  const soft = async (what: string, p: Promise<Res>): Promise<Json | undefined> => {
    try {
      const r = await p;
      if (r.status >= 300) {
        warnings.push(`${what}: ${r.status} ${r.text.slice(0, 200)}`);
        return undefined;
      }
      return r.body;
    } catch (error) {
      warnings.push(`${what}: ${(error as Error).message}`);
      return undefined;
    }
  };

  // Other people, in every role. They have no password: the demo login is their way in.
  at(88);
  for (const u of DEMO_USERS.slice(1)) {
    const id = randomUUID();
    await db.execute(
      'INSERT INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)',
      [id, u.email, u.name, world.now()],
    );
    await db.execute(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, ?)',
      [workspaceId, id, u.role],
    );
  }
  log('people');

  // ---- credentials, repository, apps ------------------------------------------------------------------------------------------
  at(87);
  const cred = async (kind: string, label: string, secret: string) =>
    (await must(`credential ${kind}`, call('POST', '/credentials', { kind, label, secret })))
      .credential.id as string;
  const asc = await cred('app_store_connect', 'Demo App Store Connect key', ASC_SECRET);
  const play = await cred('google_play', 'Demo Google Play service account', PLAY_SECRET);
  const github = await cred('github_token', 'Demo GitHub token', GITHUB_TOKEN);
  await soft(
    'translate credential',
    call('POST', '/credentials', {
      kind: 'translate_google',
      label: 'Demo translation (simulated)',
      secret: JSON.stringify({ apiKey: 'AIzaDemoDemoDemoDemoDemoDemoDemoDemo0' }),
    }),
  );
  await soft(
    'ai credential',
    call('POST', '/credentials', {
      kind: 'ai_anthropic',
      label: 'Demo AI (built-in, no network)',
      secret: JSON.stringify({ apiKey: 'sk-ant-demo-0123456789abcdefghij' }),
    }),
  );

  const repo = await must(
    'repository',
    call('POST', '/repositories', { credentialId: github, owner: REPO.owner, repo: REPO.repo }),
  );
  const repositoryId = repo.repository.id as string;

  const apps: Record<string, string> = {};
  const addApp = async (def: DemoApp, platform: Platform) => {
    const body = await must(
      `app ${def.key} ${platform}`,
      call('POST', '/apps', {
        platform,
        identifier: def.identifier,
        credentialId: platform === 'android' ? play : asc,
        repositoryId,
        name: def.name,
      }),
    );
    apps[`${def.key}:${platform}`] = body.app.id as string;
  };
  for (const def of DEMO_APPS) for (const p of def.platforms) await addApp(def, p);

  for (const def of DEMO_APPS) {
    const id = apps[`${def.key}:${def.platforms[0]}`] as string;
    await soft(
      `listing target ${def.key}`,
      call('POST', `/repositories/${repositoryId}/listing-targets`, {
        name: def.name,
        appId: id,
        ...(def.platforms.some((p) => p !== 'android')
          ? { appStoreRoot: `fastlane/metadata/${def.identifier}/ios` }
          : {}),
        ...(def.platforms.includes('android')
          ? { googlePlayRoot: `fastlane/metadata/${def.identifier}/android` }
          : {}),
      }),
    );
  }
  log('apps');

  // ---- workspace settings ----------------------------------------------------------------------------------------------
  at(86);
  await soft(
    'settings',
    call('PUT', '/settings', {
      'analytics.enabled': true,
      'analytics.appleVendorNumber': '85012345',
      'analytics.playBucketId': 'pubsite_prod_rev_01234567890123456789',
      'translation.enabled': true,
      'translation.provider': 'google',
      'translation.targetLanguage': 'en',
      'translation.mode': 'on_demand',
      'release.stalledAfterHours': 24,
      'reviews.unansweredReminderHours': 24,
      'reviews.unansweredMaxRating': 2,
    }),
  );
  await soft(
    'ai config',
    call('PUT', '/ai/config', {
      enabled: true,
      provider: 'anthropic',
      model: 'demo-model',
      monthlyTokenBudget: 500_000,
    }),
  );

  // ---- alert rules: before anything happens, so the seed's own events do not flood the inbox -------------------------------------
  {
    const owner = (
      await db.query('SELECT id FROM users WHERE email = ?', [DEMO_USERS[0].email])
    )[0];
    if (owner)
      for (const w of await seedAlertRules(db, workspaceId, String(owner.id), world.now))
        warnings.push(w);
  }

  // ---- ASO: 60 days of ranks, kept as the real refresh keeps them (one run per simulated day) ----------------------------------
  at(62);
  const keywordApps = [...DEMO_APPS].flatMap((d) => {
    const ios = apps[`${d.key}:ios`] ?? apps[`${d.key}:macos`];
    return ios ? [{ def: d, id: ios, platform: 'ios' as const }] : [];
  });
  const androidApps = DEMO_APPS.flatMap((d) =>
    apps[`${d.key}:android`]
      ? [{ def: d, id: apps[`${d.key}:android`] as string, platform: 'android' as const }]
      : [],
  );
  for (const k of [...keywordApps, ...androidApps]) {
    await soft(
      `keywords ${k.def.key} ${k.platform}`,
      call('POST', `/apps/${k.id}/aso/keywords`, {
        keywords: KEYWORDS[k.def.key].map((kw, i) => ({
          term: kw.term,
          country: kw.country,
          locale: kw.country === 'de' ? 'de-DE' : kw.country === 'fr' ? 'fr-FR' : 'en-US',
          priority: (i % 3) + 1,
          ...(i === 0 ? { tag: 'core' } : {}),
        })),
      }),
    );
    for (const c of COMPETITORS[k.def.key])
      await soft(
        `competitor ${c.name}`,
        call('POST', `/apps/${k.id}/aso/competitors`, {
          externalId:
            k.platform === 'ios' ? c.id : `com.rival.${c.name.toLowerCase().replace(/\s+/g, '')}`,
          country: 'us',
        }),
      );
  }
  for (let d = 60; d >= 0; d -= 1) {
    at(d, -1);
    for (const k of [...keywordApps, ...androidApps])
      await soft(`aso refresh day -${d}`, call('POST', `/apps/${k.id}/aso/refresh`, {}));
  }
  log('aso');

  // ---- store syncs and reads, "now" ---------------------------------------------------------------------------------------------
  // A first look three days ago: the approved Weather release has waited for a person since then (the stalled signal).
  at(3);
  for (const id of Object.values(apps)) await soft('first sync', call('POST', `/apps/${id}/sync`));
  at(0, -2);
  for (const id of Object.values(apps)) await soft('sync', call('POST', `/apps/${id}/sync`));
  at(0, -1.5);
  for (const [k, id] of Object.entries(apps)) {
    const [key, platform] = k.split(':') as [string, Platform];
    // Reviews belong to the record that owns the store app (a macOS record sharing an iOS store id owns none).
    if (platform === 'macos' && key === 'notes') continue;
    await soft(`reviews ${k}`, call('POST', `/apps/${id}/reviews/sync`));
  }
  log('sync');

  // ---- analytics ----------------------------------------------------------------------------------------------------------
  at(0, -1);
  for (const [k, id] of Object.entries(apps)) {
    const platform = k.split(':')[1];
    if (platform !== 'android') {
      const preview = await soft(
        `apple analytics preview ${k}`,
        call('GET', `/apps/${id}/analytics/apple/enable?backfill=true`),
      );
      const hash = (preview as { confirmHash?: string } | undefined)?.confirmHash;
      if (hash)
        await soft(
          `apple analytics enable ${k}`,
          call('POST', `/apps/${id}/analytics/apple/enable`, { confirmHash: hash, backfill: true }),
        );
    }
    await soft(`analytics sync ${k}`, call('POST', `/apps/${id}/analytics/sync`, {}));
    if (platform === 'android') {
      const file = playSearchTermsCsv(k.split(':')[0] as DemoApp['key'], T);
      const send = async (path: string) => raw('POST', `${W}${path}`, cookie, undefined, file);
      const prev = await send(`/apps/${id}/analytics/search-terms/import/preview`);
      const hash =
        prev.status < 300
          ? (prev.body as { confirmHash?: string } | undefined)?.confirmHash
          : undefined;
      if (!hash)
        warnings.push(`play search terms preview ${k}: ${prev.status} ${prev.text.slice(0, 200)}`);
      else {
        const done = await send(`/apps/${id}/analytics/search-terms/import?confirmHash=${hash}`);
        if (done.status >= 300)
          warnings.push(`play search terms ${k}: ${done.status} ${done.text.slice(0, 200)}`);
      }
    }
  }
  log('analytics');

  // ---- CI: read the runs so they are stored; the in-progress and the stalled one come from the repository fake --------------------
  at(0, -0.5);
  await soft('workflow runs', call('GET', `/repositories/${repositoryId}/workflows/runs`));
  await soft('active runs', call('GET', '/ci/runs/active'));
  const workflows = await soft('workflows', call('GET', `/repositories/${repositoryId}/workflows`));
  void workflows;

  // ---- reviews: triage and a note ---------------------------------------------------------------------------------------------
  at(0, -0.4);
  const admin = (
    await db.query('SELECT id FROM users WHERE email = ?', ['admin@demo.example.com'])
  )[0];
  const notesIos = apps['notes:ios'] as string;
  const list = await soft('reviews list', call('GET', `/apps/${notesIos}/reviews?limit=40`));
  const reviews: Json[] = (list?.reviews as Json[] | undefined) ?? [];
  let n = 0;
  for (const r of reviews) {
    if (r.developerResponse) continue;
    if (r.rating <= 2 && n < 6) {
      await soft(
        'triage',
        call('PATCH', `/apps/${notesIos}/reviews/${r.id}`, {
          status: n % 2 === 0 ? 'triaged' : 'ignored',
          ...(admin ? { assigneeUserId: String(admin.id) } : {}),
          internalNote:
            n === 0 ? 'Looks like the crash fixed in 3.5.0. Reply after release.' : null,
        }),
      );
      n++;
    }
  }

  // ---- staged changes on the apps that are open for editing ----------------------------------------------------------------------
  at(0, -0.3);
  const notesDef = DEMO_APPS[0] as DemoApp;
  await soft(
    'stage text',
    call('PUT', `/apps/${notesIos}/staged/text`, {
      locale: 'en-US',
      field: 'description',
      from: 'local',
      value: `${notesDef.copy.en.description}\n\nNew in 3.5: shared folders let you write together.`,
    }),
  );
  await soft(
    'stage promo',
    call('PUT', `/apps/${notesIos}/staged/text`, {
      locale: 'en-US',
      field: 'promotional_text',
      from: 'local',
      value: 'Shared folders are here. Invite a friend and write together.',
    }),
  );
  await soft(
    'stage notes',
    call('PUT', `/apps/${notesIos}/staged/text`, {
      locale: 'en-US',
      field: 'release_notes',
      from: 'local',
      value: 'Shared folders, faster search and a fix for a rare crash when pasting long text.',
    }),
  );
  await soft(
    'stage de notes',
    call('PUT', `/apps/${notesIos}/staged/text`, {
      locale: 'de-DE',
      field: 'release_notes',
      from: 'local',
      value:
        'Geteilte Ordner, schnellere Suche und ein Fix für einen seltenen Absturz beim Einfügen langer Texte.',
    }),
  );
  await soft(
    'stage assets (alpha screenshot)',
    call('PUT', `/apps/${notesIos}/staged/assets`, {
      locale: 'en-US',
      kind: 'screenshot',
      device: 'iphone_6_9',
      from: 'repo',
    }),
  );
  const notesAndroid = apps['notes:android'] as string;
  await soft(
    'stage android title',
    call('PUT', `/apps/${notesAndroid}/staged/text`, {
      locale: 'en-US',
      field: 'short_description',
      from: 'local',
      value: 'Capture ideas in a second, find them on every device. Now with shared folders.',
    }),
  );
  const weatherIos = apps['weather:ios'] as string;
  await soft(
    'stage weather promo',
    call('PUT', `/apps/${weatherIos}/staged/text`, {
      locale: 'en-US',
      field: 'promotional_text',
      from: 'local',
      value: 'Rain alerts now arrive up to 20 minutes earlier.',
    }),
  );
  log('staged');

  // ---- webhooks and one AI suggestion ----------------------------------------------------------------------------------------------
  at(0, -0.2);
  await soft(
    'webhook',
    call('POST', '/webhooks', {
      url: 'https://hooks.example.com/mrm/releases',
      description: 'Release channel (simulated receiver)',
      eventTypes: ['*'],
    }),
  );
  await soft(
    'webhook 2',
    call('POST', '/webhooks', {
      url: 'https://hooks.example.com/mrm/reviews',
      description: 'Low rating alerts (disabled)',
      eventTypes: ['review.new_low_rating'],
      enabled: false,
    }),
  );
  await soft(
    'ai keywords',
    call('POST', '/ai/tasks/keyword_ideas/run', {
      appId: notesIos,
      locale: 'en-US',
      country: 'us',
    }),
  );

  // ---- alerts: what went wrong over the last two days, through the alert services ----------------------------------------------------
  at(0);
  for (const w of await seedAlerts({
    db,
    workspaceId,
    apps,
    playCredentialId: play,
    seededAt: T,
    now: world.now,
  }))
    warnings.push(w);
  log('alerts');

  world.virtualNow = null;
  return { workspaceId, warnings, apps };
}
