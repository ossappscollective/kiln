import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import type { Database } from '@kiln/db';
import { dbTest } from '@kiln/db/testing';
import { pendingStaleFound } from '../alerts/evaluator.ts';
import { clearCurrentReadiness } from './current-readiness.ts';
import { bootStaged, type StagedBoot } from './test-helpers.ts';

/**
 * The server half of the consistency contract (docs/state-model.md "Consistency contract").
 *
 * The same stored state is read through every endpoint that states a shared fact about it, and the facts are compared. All of them are
 * views of ONE projection (`app-facts.ts`, `readAppFacts`); this test is what keeps them views:
 *
 * - `pendingCount`: what a publish would write: the length of the cart (one item per staged text, per graphics SET, per release field).
 *     cartSummary     GET /pending/cart-summary           line.count
 *     cart            GET /apps/:id/pending/cart          items.length
 *     pendingSummary  GET /pending/summary                line.count
 *     pendingView     GET /apps/:id/pending               totals.count
 * - `stagedUnpushed`: the staged part of it (`isUnpushed` of core: never pushed, or edited after its push).
 *     cart            cart items of kind listing|graphics|release
 *     pendingSummary  line.stagedUnpushed
 *     pendingView     totals.stagedUnpushed
 *     stagedView      GET /apps/:id/staged                text, assets and release entries with pushed = false
 *     alerts          `pending.stale` (alerts/evaluator.ts `pendingStaleFound`)   one item per text and per SET, never a row per file
 * - `awaitingSubmit`: a draft was pushed and waits for its submit (NOT in pendingCount).
 *     pendingSummary  line.awaitingSubmit
 *     pendingView     totals.awaitingSubmit and the items of kind pushed_draft
 * - `runBlockers`: the codes the LAST RUN kept (history), the same everywhere it is carried.
 *     publishing      GET /pending/publishing             lastPublish
 *     pendingView     lastPublish of GET /apps/:id/pending
 *     pendingSummary  lastPublish of GET /pending/summary
 * - `currentBlockers`: the codes that stand in the way of a submit NOW (the store as it is, read fresh just before).
 *     readiness       GET /apps/:id/publish/readiness
 *     pendingView     currentReadiness of GET /apps/:id/pending
 *     pendingSummary  currentReadiness of GET /pending/summary
 *
 * Where the endpoints disagree the disagreement is listed in `state-contract.expected.json` with the reason (it is empty now: every
 * endpoint of this domain is a view of the facts). The test passes while the list is exactly the current disagreements: a NEW one fails it,
 * and so does one that STOPPED (delete its entry: the burn-down). `KILN_CONTRACT_REGEN=1` prints the current list of the scenario that ran.
 */

const TEXT = 'A freshly written description that nobody else would ever write';
const OTHER = 'Another description, written after the push, that changes what is staged';
const EXPECTED_PATH = new URL('./state-contract.expected.json', import.meta.url);

type Sources = Record<string, unknown>;
type Facts = Record<string, Sources>;
type Entry = { scenario: string; fact: string; values: Sources; note: string };

async function boot(db: Database) {
  clearCurrentReadiness();
  const t = await bootStaged(db, { extra: { storePublish: { enabled: true } } });
  return t;
}
type Boot = Awaited<ReturnType<typeof boot>>;

const get = async (t: Boot, path: string) => {
  const res = await t.call(t.owner, 'GET', path);
  assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 300)}`);
  return res.body;
};

const stage = async (t: StagedBoot, app: string, field: string, value = TEXT) =>
  assert.equal(
    (await t.stageText(app, { locale: 'en-US', field, from: 'local', value })).status,
    200,
  );
const stageSet = async (t: StagedBoot, app: string) =>
  assert.equal(
    (await t.stageAssets(app, { locale: 'en-US', kind: 'screenshot', device: 'iphone_6_5' }))
      .status,
    200,
  );
const push = async (t: StagedBoot, app: string) => {
  const done = await t.previewAndPush(app);
  assert.equal(done.push.status, 200, done.push.text.slice(0, 300));
};

const codesOf = (blockers: { code: string }[] | undefined): string[] =>
  [...new Set((blockers ?? []).map((b) => b.code))].sort();

/** Every fact, from every endpoint that states it, for one app. */
async function read(t: Boot, app: string): Promise<Facts> {
  // The current reading first: the view and the summary carry the reading that is still fresh.
  const readiness = (await get(t, `/apps/${app}/publish/readiness?fresh=1`)).readiness;
  const cartSummary = await get(t, '/pending/cart-summary');
  const cart = (await get(t, `/apps/${app}/pending/cart`)).cart;
  const summary = await get(t, '/pending/summary');
  const view = (await get(t, `/apps/${app}/pending`)).pending;
  const staged = (await get(t, `/apps/${app}/staged`)).staged;
  const publishing = await get(t, '/pending/publishing');
  const stale = await pendingStaleFound(t.db, t.workspaceId, Date.now() + 60_000, 0);
  const cartLine = cartSummary.apps.find((l: { appId: string }) => l.appId === app);
  const summaryLine = summary.apps.find((l: { appId: string }) => l.appId === app);
  const items = view.platforms.flatMap((p: { items: { kind: string }[] }) => p.items);
  const kept = (publishing.lastPublish as { appId: string; lastPublish: any }[]).find(
    (l) => l.appId === app,
  )?.lastPublish;
  const keptCodes = (run: any) =>
    codesOf(run?.results?.flatMap((r: { blockers?: { code: string }[] }) => r.blockers ?? []));
  return {
    pendingCount: {
      cartSummary: cartLine?.count ?? 0,
      cart: cart.items.length,
      pendingSummary: summaryLine?.count ?? 0,
      pendingView: view.totals.count,
    },
    stagedUnpushed: {
      cart: cart.items.filter((i: { kind: string }) =>
        ['listing', 'graphics', 'release'].includes(i.kind),
      ).length,
      pendingSummary: summaryLine?.stagedUnpushed ?? 0,
      pendingView: view.totals.stagedUnpushed,
      stagedView: [...staged.text, ...staged.assets, ...staged.release].filter(
        (r: { pushed: boolean }) => !r.pushed,
      ).length,
      alerts: Number(stale.find((f) => f.appId === app)?.count ?? 0),
    },
    awaitingSubmit: {
      pendingSummary: summaryLine?.awaitingSubmit ?? 0,
      pendingView: view.totals.awaitingSubmit,
      pendingViewItems: items.filter((i: { kind: string }) => i.kind === 'pushed_draft').length,
    },
    runBlockers: {
      publishing: keptCodes(kept),
      pendingView: keptCodes(view.lastPublish),
      pendingSummary: keptCodes(summaryLine?.lastPublish),
    },
    currentBlockers: {
      readiness: codesOf(readiness.blockers),
      pendingView: codesOf(view.currentReadiness?.blockers),
      // An app with nothing pending has no line in the summary: it says nothing about a reading.
      ...(summaryLine ? { pendingSummary: codesOf(summaryLine.currentReadiness?.blockers) } : {}),
    },
  };
}

const canon = (v: unknown) => JSON.stringify(v);
function disagreements(scenario: string, facts: Facts): Entry[] {
  const out: Entry[] = [];
  for (const [fact, sources] of Object.entries(facts)) {
    if (new Set(Object.values(sources).map(canon)).size > 1)
      out.push({ scenario, fact, values: sources, note: '' });
  }
  return out;
}

const expectedFile = (): { entries: Entry[] } => JSON.parse(readFileSync(EXPECTED_PATH, 'utf8'));
const summaryRows: string[] = [];

/** The scenario's disagreements must be exactly its expected entries (values included). */
function check(scenario: string, facts: Facts) {
  const now = disagreements(scenario, facts);
  for (const [fact, sources] of Object.entries(facts))
    summaryRows.push(
      `${scenario.padEnd(28)} ${fact.padEnd(15)} ${Object.entries(sources)
        .map(([k, v]) => `${k}=${canon(v)}`)
        .join(' ')}`,
    );
  if (process.env.KILN_CONTRACT_REGEN === '1') {
    const old = expectedFile().entries;
    const kept = old.filter((e) => e.scenario !== scenario);
    const next = [
      ...kept,
      ...now.map((e) => ({
        ...e,
        note: old.find((o) => o.scenario === e.scenario && o.fact === e.fact)?.note ?? 'TODO',
      })),
    ];
    writeFileSync(EXPECTED_PATH, `${JSON.stringify({ entries: next }, null, 2)}\n`);
    return;
  }
  const expected = expectedFile().entries.filter((e) => e.scenario === scenario);
  const key = (e: Entry) => e.fact;
  const added = now.filter((e) => !expected.some((x) => key(x) === key(e)));
  const fixed = expected.filter((x) => !now.some((e) => key(x) === key(e)));
  const changed = now.filter((e) =>
    expected.some((x) => key(x) === key(e) && canon(x.values) !== canon(e.values)),
  );
  assert.deepEqual(
    added.map((e) => `${e.fact} ${canon(e.values)}`),
    [],
    `${scenario}: NEW disagreement between endpoints. Fix the endpoint, or (only if it cannot be fixed now) add it to state-contract.expected.json with a note.`,
  );
  assert.deepEqual(
    fixed.map((e) => e.fact),
    [],
    `${scenario}: these endpoints now agree. Delete the entry from state-contract.expected.json (burn-down).`,
  );
  assert.deepEqual(
    changed.map((e) => `${e.fact} ${canon(e.values)}`),
    [],
    `${scenario}: the disagreement changed its values: update state-contract.expected.json and say why.`,
  );
}

dbTest('contract: nothing staged, nothing pending (control)', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  check('quiet', await read(t, app));
});

dbTest('contract: one text and one screenshot set staged', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await stage(t, app, 'description');
  await stageSet(t, app);
  check('text-and-set', await read(t, app));
});

dbTest('contract: three texts staged', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await stage(t, app, 'description');
  await stage(t, app, 'keywords', 'notes, scanner, pdf');
  await stage(t, app, 'support_url', 'https://example.com/support');
  check('three-texts', await read(t, app));
});

dbTest('contract: staged, then pushed as a draft', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await stage(t, app, 'description');
  await stageSet(t, app);
  await push(t, app);
  check('pushed-draft', await read(t, app));
});

dbTest('contract: pushed, then the text edited again', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await stage(t, app, 'description');
  await push(t, app);
  await stage(t, app, 'description', OTHER);
  check('edited-after-push', await read(t, app));
});

dbTest('contract: a publish blocked at the submit, then the cause is fixed', async (db) => {
  const t = await boot(db);
  const app = await t.addApp('ios');
  await stage(t, app, 'description');
  await stageSet(t, app);
  const plan = (await t.call(t.owner, 'POST', `/apps/${app}/publish/preview`, {})).body.plan;
  assert.equal(plan.confirmable, true, JSON.stringify(plan.steps).slice(0, 300));
  const good = t.submitStores.ios.build;
  const store = t.stores.ios;
  const original = store.applyDraft.bind(store);
  store.applyDraft = async (input) => {
    const result = await original(input);
    t.submitStores.ios.build = null;
    return result;
  };
  const done = await t.call(t.owner, 'POST', `/apps/${app}/publish`, {
    planHash: plan.planHash,
    phrase: plan.confirmation.phrase,
    steps: plan.publishSteps,
  });
  assert.equal(done.status, 200, done.text.slice(0, 300));
  // The build comes back (the person fixed it): the run kept `no_build`, the store says nothing stands in the way now.
  t.submitStores.ios.build = good;
  check('blocked-run-then-fixed', await read(t, app));
});

dbTest('contract: every expected entry names a scenario that runs', async () => {
  const known = [
    'quiet',
    'text-and-set',
    'three-texts',
    'pushed-draft',
    'edited-after-push',
    'blocked-run-then-fixed',
  ];
  const entries = expectedFile().entries;
  for (const e of entries) {
    assert.ok(known.includes(e.scenario), `unknown scenario ${e.scenario}`);
    assert.ok(e.note.length > 10 && e.note !== 'TODO', `${e.scenario}/${e.fact}: say why`);
  }
  assert.equal(new Set(entries.map((e) => `${e.scenario}/${e.fact}`)).size, entries.length);
  assert.ok(
    !entries.some((e) => e.scenario === 'quiet'),
    'the control scenario must have no disagreement',
  );
});

process.on('exit', () => {
  if (summaryRows.length > 0) console.log(`\nserver contract facts\n${summaryRows.join('\n')}`);
});
