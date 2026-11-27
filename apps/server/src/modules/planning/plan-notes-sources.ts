import { type NoteSources, type Platform, supports } from '@kiln/core';
import type { Sql } from '@kiln/db';
import { getStoreListing } from '../listing/store-view.ts';
import { loadStagedRows } from '../publish/staged-changes.ts';

/**
 * The notes of the places other than the plan, for `computeReadiness` (docs/state-model.md, "Single owners (core)": the release notes live in
 * five places and one view merges them). Reads the database only: the staged rows and the stored store snapshot (the listing's editable
 * copy: the App Store `release_notes` text of the draft). The Google Play notes of the track are not part of the listing snapshot, so the
 * Play store place is the staged release field alone.
 */
export type PlanNoteSources = {
  sources: Omit<NoteSources, 'plan'>;
  /** The locales of the listing (the editable copy's): each must have notes. */
  locales: string[];
};

export async function planNoteSourcesOf(
  sql: Sql,
  workspaceId: string,
  app: { id: string; platform: Platform; identifier: string },
): Promise<PlanNoteSources> {
  const apple = !supports(app.platform, 'releaseTracks');
  const rows = await loadStagedRows(sql, workspaceId, app.id);
  const staged = rows
    .filter(
      (r) => r.target === 'release_notes' && r.kind === (apple ? 'listing_text' : 'release_field'),
    )
    .map((r) => ({
      locale: r.locale,
      text: r.valueText,
      pushed: r.pushedHash !== null && r.pushedHash === r.valueHash,
    }));
  const store = await getStoreListing(sql, workspaceId, app);
  const editable = store.copies.editable;
  return {
    sources: {
      staged,
      ...(apple
        ? {
            store: editable.locales.map((l) => ({
              locale: l.locale,
              text: l.fields.release_notes ?? null,
            })),
          }
        : {}),
    },
    locales: editable.codes,
  };
}
