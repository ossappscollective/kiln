import assert from 'node:assert/strict';
import {
  type ReviewCarryResult,
  type StoreVersionRow,
  type VersionCreateInput,
  type VersionCreateResult,
  VersionDriftError,
  type VersionListState,
} from '@kiln/connectors';
import {
  emptyReviewDetail,
  maskedReviewSummary,
  mergeReviewDetail,
  type ReviewDetail,
  reviewDetailHasContent,
  reviewSourceOrder,
} from '@kiln/core';
import { dbTest } from '@kiln/db/testing';
import { setPolicy } from '../../services/step-up.ts';
import type { VersionConnector, VersionConnectorInput } from './store-version.ts';
import { bootStaged } from './test-helpers.ts';

/**
 * The App Review Information of the previous version, carried over to a version Kiln creates and to one that already exists
 * (docs/api/review-information.md). Everything runs against a fake that keeps review details in memory and uses the same pure
 * rules as the connector (`mergeReviewDetail`, `reviewSourceOrder`): no store is contacted. The connector's own wire behaviour is
 * tested in packages/connectors (appstore-review-detail.test.ts). Every answer, audit entry and log line is checked for personal data.
 */

const FULL: ReviewDetail = {
  text: {
    contactFirstName: 'Marie',
    contactLastName: 'Girard',
    contactPhone: '+33 1 23 45 67 89',
    contactEmail: 'marie.girard@example.test',
    demoAccountName: 'reviewer@example.test',
    demoAccountPassword: 'Tr0ub4dor-secret',
    notes: 'Open Settings, then Account.',
  },
  demoAccountRequired: true,
};
const PII = ['Marie', 'Girard', '+33 1 23', 'example.test', 'Tr0ub4dor', 'Open Settings'];
const noPii = (value: unknown, label = '') => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of PII) assert.ok(!text.includes(secret), `${label} leaked ${secret}`);
};

const EDITABLE = ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'];
const row = (id: string, versionString: string, state: string): StoreVersionRow => ({
  id,
  versionString,
  state,
  editable: EDITABLE.includes(state),
});

type Write = { kind: 'POST' | 'PATCH'; versionId: string; attributes: Record<string, unknown> };

class FakeReviewStore implements VersionConnector {
  versions: StoreVersionRow[] = [
    row('v1', '1.19.0', 'READY_FOR_SALE'),
    row('v0', '1.18.0', 'REPLACED_WITH_NEW_VERSION'),
  ];
  /** Review details by version id. */
  details = new Map<string, ReviewDetail>([['v1', structuredClone(FULL)]]);
  writes: Write[] = [];
  creates: string[] = [];
  /** The carry-over fails (a refusal by Apple). */
  failCarry = false;
  /** An in-memory detail the new version already has when it is created (Apple filled it). */
  newVersionDetail: ReviewDetail | undefined;
  reads = 0;
  platform = 'ios' as const;

  async readVersions(): Promise<VersionListState> {
    this.reads++;
    return {
      store: 'appstoreconnect',
      platform: 'ios',
      versions: this.versions.map((v) => ({ ...v })),
    };
  }
  async createVersion(input: VersionCreateInput): Promise<VersionCreateResult> {
    const before = await this.readVersions();
    if (!input.guard(before)) throw new VersionDriftError(before);
    this.creates.push(input.request.versionString);
    this.versions.push(row('v-new', input.request.versionString, 'PREPARE_FOR_SUBMISSION'));
    if (this.newVersionDetail) this.details.set('v-new', structuredClone(this.newVersionDetail));
    return {
      before,
      version: { id: 'v-new', versionString: input.request.versionString, state: 'PREPARE_FOR_SUBMISSION' },
    };
  }

  #source(versions: readonly StoreVersionRow[], targetId: string) {
    for (const c of reviewSourceOrder(versions, targetId)) {
      const d = this.details.get(c.id);
      if (d && reviewDetailHasContent(d)) return { c, d };
    }
    return null;
  }
  async previewReviewInformation(versions: readonly StoreVersionRow[], targetId: string | null = null): Promise<ReviewCarryResult> {
    const source = this.#source(versions, targetId ?? '');
    if (!source) return { outcome: 'no_source', from: null, fieldsCopied: 0, summary: null };
    const target = targetId === null ? null : (this.details.get(targetId) ?? null);
    const merge = mergeReviewDetail(target, source.d);
    return {
      outcome: merge.fieldsCopied === 0 ? 'already_complete' : target ? 'merged' : 'created',
      from: { id: source.c.id, versionString: source.c.versionString },
      fieldsCopied: merge.fieldsCopied,
      summary: maskedReviewSummary(source.d),
    };
  }
  async carryOverReviewInformation(versions: readonly StoreVersionRow[], targetId: string): Promise<ReviewCarryResult> {
    const look = await this.previewReviewInformation(versions, targetId);
    if (look.fieldsCopied === 0) return look;
    if (this.failCarry)
      return { outcome: 'failed', from: null, fieldsCopied: 0, summary: null, code: 'store_rejected', httpStatus: 409 };
    const source = this.#source(versions, targetId);
    if (!source) return look;
    const target = this.details.get(targetId) ?? null;
    const merge = mergeReviewDetail(target, source.d);
    const next: ReviewDetail = target ? structuredClone(target) : emptyReviewDetail();
    for (const [k, v] of Object.entries(merge.attributes)) {
      if (k === 'demoAccountRequired') next.demoAccountRequired = v as boolean;
      else (next.text as Record<string, string | null>)[k] = v as string;
    }
    this.details.set(targetId, next);
    this.writes.push({ kind: target ? 'PATCH' : 'POST', versionId: targetId, attributes: merge.attributes });
    return look;
  }
}

function boot(options: Parameters<typeof bootStaged>[1] = {}) {
  return async (db: Parameters<typeof bootStaged>[0]) => {
    const store = new FakeReviewStore();
    const lines: string[] = [];
    const t = await bootStaged(db, {
      ...options,
      extra: {
        storeVersion: { connectorFactory: (_input: VersionConnectorInput) => store },
        storePublish: { enabled: true, log: (l: string) => lines.push(l) },
      },
    });
    const create = async (appId: string, versionString: string, cookie = t.owner) => {
      const p = await t.call(cookie, 'POST', `/apps/${appId}/store-version/preview`, { versionString });
      const c = await t.call(cookie, 'POST', `/apps/${appId}/store-version`, {
        versionString,
        confirmHash: p.body.preview?.confirmHash,
      });
      return { preview: p, create: c };
    };
    const copyPreview = (appId: string, cookie = t.owner) =>
      t.call(cookie, 'POST', `/apps/${appId}/review-information/preview`, {});
    const copy = (appId: string, confirmHash: string, cookie = t.owner) =>
      t.call(cookie, 'POST', `/apps/${appId}/review-information`, { confirmHash });
    return { t, store, lines, create, copyPreview, copy };
  };
}
type Booted = Awaited<ReturnType<Awaited<ReturnType<typeof boot>>>>;
const withBoot = (
  name: string,
  fn: (b: Booted, db: Parameters<typeof bootStaged>[0]) => Promise<void>,
  options: Parameters<typeof bootStaged>[1] = {},
) => dbTest(name, async (db) => fn(await (await boot(options))(db), db));

/** Runs `job` and returns everything it wrote with console.*: no personal data may be in it. */
async function consoleOf(job: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map((m) => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    await job();
  } finally {
    methods.forEach((m, i) => {
      console[m] = saved[i] as never;
    });
  }
  return lines.join('\n');
}

/** Everything the server wrote down: the audit log and every column of the database that could hold a value. */
const auditText = async (b: Booted) => JSON.stringify(await b.t.audit('store.%'));

// ----- creating a version -------------------------------------------------------------------------------------------

withBoot('create: the previous version has full details, so they are written to the new version, with counts and a masked answer', async (b) => {
  const app = await b.t.addApp('ios');
  const preview = await b.t.call(b.t.owner, 'POST', `/apps/${app}/store-version/preview`, { versionString: '1.19.1' });
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(preview.body.preview.reviewInformation, {
    outcome: 'created',
    from: '1.19.0',
    fieldsCopied: 8,
    summary: { contact: 'M. G.', phone: true, email: true, demoAccount: 'required', demoCredentials: true, notes: true },
  });
  assert.equal(b.store.writes.length, 0, 'the preview wrote nothing');
  let done!: Awaited<ReturnType<Booted['create']>>;
  const printed = await consoleOf(async () => {
    done = await b.create(app, '1.19.1');
  });
  noPii(printed, 'console');
  assert.equal(done.create.status, 200, done.create.text);
  const r = done.create.body.result;
  assert.equal(r.reviewInformation.outcome, 'created');
  assert.equal(r.reviewInformation.from, '1.19.0');
  assert.equal(r.reviewInformation.fieldsCopied, 8);
  assert.deepEqual(b.store.writes.map((w) => [w.kind, w.versionId]), [['POST', 'v-new']]);
  assert.deepEqual(b.store.writes[0]?.attributes, {
    ...FULL.text,
    demoAccountRequired: true,
  });
  assert.deepEqual(r.warnings, []);
  noPii(preview.text, 'preview');
  noPii(done.create.text, 'create');
  const audit = await b.t.audit('store.version_created');
  assert.deepEqual(audit[0]?.detail.reviewInformation, {
    outcome: 'created',
    fromVersion: '1.19.0',
    fromVersionId: 'v1',
    fieldsCopied: 8,
  });
  noPii(await auditText(b), 'audit');
  noPii(b.lines.join('\n'), 'log');
  assert.equal(await b.t.claim(app), undefined);
});

withBoot('create: no previous version has details, so nothing is written and the answer says so with a warning', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.details.clear();
  const done = await b.create(app, '1.19.1');
  assert.equal(done.create.status, 200, done.create.text);
  assert.equal(done.create.body.result.reviewInformation.outcome, 'no_source');
  assert.deepEqual(done.create.body.result.warnings.map((w: any) => w.code), ['review_information_missing']);
  assert.equal(b.store.writes.length, 0);
  assert.equal(((await b.t.audit('store.version_created'))[0]?.detail.reviewInformation as { outcome: string }).outcome, 'no_source');
});

withBoot('create: a new version that already has details is only filled where blank, never overwritten', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.newVersionDetail = {
    ...emptyReviewDetail(),
    text: { ...emptyReviewDetail().text, contactFirstName: 'Paul', contactPhone: '  ' },
    demoAccountRequired: false,
  };
  const done = await b.create(app, '1.19.1');
  assert.equal(done.create.status, 200, done.create.text);
  assert.equal(done.create.body.result.reviewInformation.outcome, 'merged');
  const write = b.store.writes[0];
  assert.equal(write?.kind, 'PATCH');
  assert.equal(write?.attributes.contactFirstName, undefined);
  assert.equal(write?.attributes.contactPhone, FULL.text.contactPhone);
  assert.equal(b.store.details.get('v-new')?.text.contactFirstName, 'Paul');
  noPii(done.create.text);
  noPii(await auditText(b));
});

withBoot('create: a refused carry-over does not undo the version: it is created, with a warning and a failed outcome, and nothing personal anywhere', async (b) => {
  const app = await b.t.addApp('ios');
  b.store.failCarry = true;
  const done = await b.create(app, '1.19.1');
  assert.equal(done.create.status, 200, done.create.text);
  const r = done.create.body.result;
  assert.equal(r.version.id, 'v-new');
  assert.equal(r.reviewInformation.outcome, 'failed');
  assert.equal(r.reviewInformation.code, 'store_rejected');
  assert.deepEqual(r.warnings.map((w: any) => w.code), ['review_information_not_copied']);
  assert.equal(((await b.t.audit('store.version_created'))[0]?.detail.reviewInformation as { outcome: string }).outcome, 'failed');
  noPii(done.create.text);
  noPii(await auditText(b));
  noPii(b.lines.join('\n'));
  assert.equal(await b.t.claim(app), undefined);
});

// ----- the repair -------------------------------------------------------------------------------------------------

const withDraft = (b: Booted) => {
  b.store.versions.push(row('v-new', '1.19.1', 'PREPARE_FOR_SUBMISSION'));
};

withBoot('repair: preview is masked and writes nothing; apply copies once, audits ids and counts, and a second apply is refused', async (b) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  const p = await b.copyPreview(app);
  assert.equal(p.status, 200, p.text);
  const preview = p.body.preview;
  assert.equal(preview.canCopy, true);
  assert.deepEqual(preview.version, { versionString: '1.19.1', state: 'PREPARE_FOR_SUBMISSION' });
  assert.equal(preview.reviewInformation.from, '1.19.0');
  assert.equal(preview.reviewInformation.summary.contact, 'M. G.');
  assert.match(preview.confirmHash, /^[0-9a-f]{64}$/);
  assert.equal(b.store.writes.length, 0);
  noPii(p.text, 'preview');
  const done = await b.copy(app, preview.confirmHash);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.result.reviewInformation.outcome, 'created');
  assert.deepEqual(b.store.writes.map((w) => [w.kind, w.versionId]), [['POST', 'v-new']]);
  noPii(done.text, 'apply');
  const audit = await b.t.audit('store.review_information_copied');
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.detail.versionId, 'v-new');
  assert.equal(audit[0]?.detail.fromVersion, '1.19.0');
  assert.equal(audit[0]?.detail.fieldsCopied, 8);
  noPii(await auditText(b), 'audit');
  noPii(b.lines.join('\n'), 'log');
  assert.equal(await b.t.claim(app), undefined);
  // Nothing is left to copy: the old hash is refused with a new preview that says so, and nothing more is written.
  const again = await b.copy(app, preview.confirmHash);
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'state_changed');
  assert.equal(again.body.preview.canCopy, false);
  assert.equal(b.store.writes.length, 1);
  assert.equal((await b.copyPreview(app)).body.preview.reviewInformation.outcome, 'already_complete');
});

withBoot('repair: a draft whose detail is partly filled is patched where blank only', async (b) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  b.store.details.set('v-new', { ...emptyReviewDetail(), text: { ...emptyReviewDetail().text, contactEmail: 'mine@example.test' }, demoAccountRequired: false });
  const p = await b.copyPreview(app);
  assert.equal(p.body.preview.reviewInformation.outcome, 'merged');
  const done = await b.copy(app, p.body.preview.confirmHash);
  assert.equal(done.status, 200, done.text);
  assert.equal(b.store.writes[0]?.kind, 'PATCH');
  assert.equal(b.store.writes[0]?.attributes.contactEmail, undefined);
  assert.equal(b.store.details.get('v-new')?.text.contactEmail, 'mine@example.test');
});

withBoot('repair: with no source there is nothing to copy (no hash), and a made-up hash writes nothing', async (b) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  b.store.details.clear();
  const p = await b.copyPreview(app);
  assert.equal(p.body.preview.canCopy, false);
  assert.equal(p.body.preview.confirmHash, null);
  assert.equal(p.body.preview.reviewInformation.outcome, 'no_source');
  const res = await b.copy(app, 'a'.repeat(64));
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'state_changed');
  assert.equal(b.store.writes.length, 0);
  assert.equal((await b.t.audit('store.review_information_copy_failed'))[0]?.detail.code, 'state_changed');
});

withBoot('repair: no editable version, and two, are refused without a write', async (b) => {
  const app = await b.t.addApp('ios');
  const none = await b.copyPreview(app);
  assert.equal(none.status, 409);
  assert.equal(none.body.error, 'no_editable_version');
  withDraft(b);
  b.store.versions.push(row('v-two', '1.19.2', 'REJECTED'));
  const two = await b.copyPreview(app);
  assert.equal(two.body.error, 'several_editable_versions');
  assert.equal((await b.copy(app, 'a'.repeat(64))).status, 409);
  assert.equal(b.store.writes.length, 0);
});

withBoot('repair: a refused write is 502 store_rejected with the kind of the failure and nothing personal; the claim is released', async (b) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  const p = await b.copyPreview(app);
  b.store.failCarry = true;
  const res = await b.copy(app, p.body.preview.confirmHash);
  assert.equal(res.status, 502);
  assert.equal(res.body.error, 'store_rejected');
  assert.equal(res.body.cause, 'store_rejected');
  noPii(res.text);
  assert.equal((await b.t.audit('store.review_information_copy_failed'))[0]?.detail.outcome, 'failed');
  noPii(await auditText(b));
  assert.equal(await b.t.claim(app), undefined);
});

withBoot('repair: owners and admins only (viewers and members 403, outsiders 404); Google Play is not supported', async (b) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  for (const role of ['viewer', 'member'] as const) {
    const cookie = await b.t.addMember(role);
    assert.equal((await b.copyPreview(app, cookie)).status, 403);
    assert.equal((await b.copy(app, 'a'.repeat(64), cookie)).status, 403);
  }
  assert.equal(b.store.reads, 0);
  const admin = await b.t.addMember('admin');
  assert.equal((await b.copyPreview(app, admin)).status, 200);
  await b.t.db.execute("INSERT INTO workspaces (id, name, created_at) VALUES ('other', 'Other', 0)");
  const outsider = await b.t.addMember('owner', 'other');
  assert.equal((await b.copyPreview(app, outsider)).status, 404);
  const play = await b.t.addApp('android');
  assert.equal((await b.copyPreview(play)).status, 422);
});

withBoot('repair: with the draft switch off both routes answer 409 store_draft_disabled and no store is reached', async (b) => {
  const app = await b.t.addApp('ios');
  for (const res of [await b.copyPreview(app), await b.copy(app, 'a'.repeat(64))]) {
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'store_draft_disabled');
  }
  assert.equal(b.store.reads, 0);
}, { draft: { enabled: false } });

withBoot('repair: a workspace that covers store.push_draft with a step-up asks for the confirmation on the write; the preview stays free', async (b, db) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  await setPolicy(
    db,
    { workspaceId: b.t.workspaceId, policy: { mode: 'hard_actions', actions: ['store.push_draft'], unattended: [] }, userId: 'u' },
    Date.now(),
  );
  const p = await b.copyPreview(app);
  assert.equal(p.status, 200);
  const res = await b.copy(app, p.body.preview.confirmHash);
  assert.equal(res.status, 403);
  assert.match(String(res.body.error), /^step_up/);
  assert.equal(b.store.writes.length, 0);
});

withBoot('repair: one write at a time, shared with the draft push and the version create', async (b, db) => {
  const app = await b.t.addApp('ios');
  withDraft(b);
  const p = await b.copyPreview(app);
  await db.execute(
    "INSERT INTO store_draft_claims (app_id, platform, workspace_id, action, status, claimed_by, claim_at) VALUES (?, 'ios', ?, 'push_draft', 'writing', 'u', ?)",
    [app, b.t.workspaceId, Date.now()],
  );
  const res = await b.copy(app, p.body.preview.confirmHash);
  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'write_in_progress');
  assert.equal(b.store.writes.length, 0);
});

withBoot('the API description lists both routes with the draft push action', async (b) => {
  const res = await b.t.app.request('/api/openapi.json', { headers: { cookie: b.t.owner } });
  const doc = (await res.json()) as { paths: Record<string, Record<string, Record<string, unknown>>> };
  const at = (path: string) => doc.paths[`/api/workspaces/{workspaceId}${path}`]?.post;
  assert.equal(at('/apps/{id}/review-information/preview')?.['x-kiln-action'], 'store.push_draft');
  assert.equal(at('/apps/{id}/review-information/preview')?.['x-kiln-risk'], 'read');
  assert.equal(at('/apps/{id}/review-information')?.['x-kiln-action'], 'store.push_draft');
  assert.equal(at('/apps/{id}/review-information')?.['x-kiln-risk'], 'destructive');
});

