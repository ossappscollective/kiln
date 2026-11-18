import { type DraftReadRequest, type DraftState, type DraftFile, setMatches } from '@mrm/connectors';
import type { AssetKind, Platform } from '@mrm/core';
import type { Sql } from '@mrm/db';
import { hashListingValue } from './listing-drift.ts';

/**
 * What the last successful draft pushes of an app and platform wrote to the store's draft
 * (`store_draft_pushes`, migration 24, docs/adr/0010-store-submit.md). A submit for review requires it and
 * reads the store again to check the draft still holds exactly this. Hashes and ids only: never a text, a
 * file, a credential or an upload address.
 *
 * A later push MERGES into the record (an item pushed again replaces its older entry), so the record is
 * "everything this server has written to the draft since the last submit". A submit deletes it.
 */

export type PushedText = { locale: string; field: string; hash: string };
export type PushedSet = {
  locale: string;
  /** The slot key (`screenshot:iphone_6_5`). */
  key: string;
  kind: AssetKind;
  device: string | null;
  /** This server's name of the set (the App Store display type, the Google Play image type). */
  target: string;
  /** The pixel size of the first file: the App Store connector finds the placement group from it. */
  width: number | null;
  height: number | null;
  files: { md5: string; sha256: string }[];
};
export type PushedManifest = { v: 1; text: PushedText[]; assets: PushedSet[] };

export type PushRecord = {
  appId: string;
  platform: Platform;
  versionId: string | null;
  versionString: string | null;
  /** The confirm hash of the last push that was merged in. */
  confirmHash: string;
  manifest: PushedManifest;
  pushedBy: string;
  pushedAt: number;
  updatedAt: number;
};

export const emptyManifest = (): PushedManifest => ({ v: 1, text: [], assets: [] });

export const textEntry = (locale: string, field: string, value: string): PushedText => ({ locale, field, hash: hashListingValue(value) });

export const fileEntry = (file: Pick<DraftFile, 'md5' | 'sha256'>) => ({ md5: file.md5, sha256: file.sha256 });

/** `add` replaces the entries of `base` for the same item and keeps the rest. */
export function mergeManifest(base: PushedManifest, add: PushedManifest): PushedManifest {
  const text = new Map(base.text.map((t) => [`${t.locale}\u0000${t.field}`, t]));
  for (const t of add.text) text.set(`${t.locale}\u0000${t.field}`, t);
  const assets = new Map(base.assets.map((a) => [`${a.locale}\u0000${a.key}`, a]));
  for (const a of add.assets) assets.set(`${a.locale}\u0000${a.key}`, a);
  const sortText = (a: PushedText, b: PushedText) => (`${a.locale}\u0000${a.field}` < `${b.locale}\u0000${b.field}` ? -1 : 1);
  const sortSet = (a: PushedSet, b: PushedSet) => (`${a.locale}\u0000${a.key}` < `${b.locale}\u0000${b.key}` ? -1 : 1);
  return { v: 1, text: [...text.values()].sort(sortText), assets: [...assets.values()].sort(sortSet) };
}

const parse = (raw: unknown): PushedManifest => {
  try {
    const value = JSON.parse(String(raw)) as Partial<PushedManifest>;
    if (value && value.v === 1 && Array.isArray(value.text) && Array.isArray(value.assets)) return value as PushedManifest;
  } catch {
    // fall through
  }
  return emptyManifest();
};

export async function loadPush(sql: Sql, appId: string, platform: Platform): Promise<PushRecord | undefined> {
  const [row] = await sql.query('SELECT * FROM store_draft_pushes WHERE app_id = ? AND platform = ?', [appId, platform]);
  if (!row) return undefined;
  return {
    appId: String(row.app_id),
    platform: String(row.platform) as Platform,
    versionId: row.version_id === null || row.version_id === undefined ? null : String(row.version_id),
    versionString: row.version_string === null || row.version_string === undefined ? null : String(row.version_string),
    confirmHash: String(row.confirm_hash),
    manifest: parse(row.items),
    pushedBy: String(row.pushed_by),
    pushedAt: Number(row.pushed_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Records a successful push: merges into the existing record of the same version, replaces the record of an older one. */
export async function recordPush(
  sql: Sql,
  input: { workspaceId: string; appId: string; platform: Platform; version: { id: string; versionString: string | null } | null; confirmHash: string; manifest: PushedManifest; actorId: string; at: number },
): Promise<void> {
  const existing = await loadPush(sql, input.appId, input.platform);
  const sameVersion = existing !== undefined && (existing.versionId ?? null) === (input.version?.id ?? null);
  const manifest = sameVersion && existing ? mergeManifest(existing.manifest, input.manifest) : input.manifest;
  const items = JSON.stringify(manifest);
  if (!existing) {
    await sql.execute(
      `INSERT INTO store_draft_pushes (app_id, platform, workspace_id, version_id, version_string, confirm_hash, items, pushed_by, pushed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.appId, input.platform, input.workspaceId, input.version?.id ?? null, input.version?.versionString ?? null, input.confirmHash, items, input.actorId, input.at, input.at],
    );
    return;
  }
  await sql.execute(
    `UPDATE store_draft_pushes
        SET version_id = ?, version_string = ?, confirm_hash = ?, items = ?, pushed_by = ?, pushed_at = ?, updated_at = ?
      WHERE app_id = ? AND platform = ?`,
    [input.version?.id ?? null, input.version?.versionString ?? null, input.confirmHash, items, input.actorId, sameVersion ? existing.pushedAt : input.at, input.at, input.appId, input.platform],
  );
}

export const deletePush = (sql: Sql, appId: string, platform: Platform) =>
  sql.execute('DELETE FROM store_draft_pushes WHERE app_id = ? AND platform = ?', [appId, platform]);

/** What the store must be read for to compare with the record. */
export const requestOfManifest = (m: PushedManifest): DraftReadRequest => ({
  text: m.text.map((t) => ({ locale: t.locale, field: t.field })),
  assets: m.assets.map((a) => ({ locale: a.locale, kind: a.kind, device: a.device, target: a.target, width: a.width, height: a.height })),
});

export type Mismatch = { type: 'text' | 'asset'; locale: string; item: string };

/** The pushed items the store's draft does not hold any more (changed by someone else, or not shown by the store). */
export function manifestMismatches(m: PushedManifest, draft: DraftState): Mismatch[] {
  const out: Mismatch[] = [];
  for (const t of m.text) {
    const found = draft.text.find((s) => s.locale === t.locale && s.field === t.field);
    if (!found || found.value === null || hashListingValue(found.value) !== t.hash) out.push({ type: 'text', locale: t.locale, item: t.field });
  }
  for (const a of m.assets) {
    const found = draft.assets.find((s) => s.locale === a.locale && s.target === a.target);
    if (!found || !setMatches(found.images, a.files) || (found.images.length === 0 && a.files.length > 0)) out.push({ type: 'asset', locale: a.locale, item: a.key });
  }
  return out;
}
