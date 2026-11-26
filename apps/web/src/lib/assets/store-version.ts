import type { StoreImagesView } from '@kiln/core';

/**
 * Which App Store version the Graphics tab shows, so a person knows what a removal touches. Kiln edits the DRAFT version (the one in
 * "Prepare for Submission"); the live version cannot be edited while it is live and keeps its own screenshots until the draft is
 * released. Pure. `channel` is what was asked for: `editable` reads the draft (or the live version when there is no draft), `live`
 * reads the live version.
 *
 * - `draft`: the version Kiln edits;
 * - `live`: the live version, asked for with the switch (read only);
 * - `live_only`: the live version, shown because the app has no draft (nothing can be edited until a new version is created).
 * Google Play has one listing (no version): null.
 */
export type StoreVersionKind = 'draft' | 'live' | 'live_only';
export type StoreVersionLabel = { kind: StoreVersionKind; version: string; editable: boolean };

export function storeVersionLabel(
  view: Pick<StoreImagesView, 'version'> | null,
  channel: 'editable' | 'live' = 'editable',
): StoreVersionLabel | null {
  const v = view?.version ?? null;
  if (v === null) return null;
  const version = v.versionString ?? '';
  if (channel === 'live') return { kind: 'live', version, editable: false };
  return v.editable
    ? { kind: 'draft', version, editable: true }
    : { kind: 'live_only', version, editable: false };
}

/** The switch between the draft and the live version is offered for the App Store only (Google Play has no version to switch to). */
export const offersChannelSwitch = (view: Pick<StoreImagesView, 'platform'> | null): boolean =>
  view?.platform === 'ios' || view?.platform === 'macos';
