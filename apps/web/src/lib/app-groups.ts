import { type Platform, sortPlatforms } from '@mrm/core';
import { findSiblings } from './release.ts';
import { sortApps } from './portfolio.ts';
import type { AppSummary } from './types.ts';

/**
 * One product as people see it: the iOS, macOS and Android apps that are the same product (the same
 * identifier, else the same name) merged. Each platform keeps its own record in the data model, so a
 * group only joins them in the web layer. An iOS and a macOS record may share a bundle id (universal
 * purchase) or have different ones; both join by identifier first, then by name.
 */
export type AppGroup = {
  /** The id of the first record (iOS when there is one). Stable while the records stay. */
  key: string;
  name: string;
  ios: AppSummary | null;
  macos: AppSummary | null;
  android: AppSummary | null;
  /** iOS, macOS, Android. */
  members: AppSummary[];
  /** The platforms the product is on, in that order. */
  platforms: Platform[];
};

const make = (members: AppSummary[]): AppGroup => {
  const of = (platform: Platform) => members.find((m) => m.platform === platform) ?? null;
  const platforms = sortPlatforms(members.map((m) => m.platform));
  const ordered = platforms.map((p) => of(p) as AppSummary);
  const first = ordered[0] as AppSummary;
  return { key: first.id, name: first.name, ios: of('ios'), macos: of('macos'), android: of('android'), members: ordered, platforms };
};

/** Joins apps into groups, sorted by name. A record with no safe partner is a group of one. */
export function groupApps(apps: readonly AppSummary[]): AppGroup[] {
  const pending = sortApps(apps);
  const taken = new Set<string>();
  const groups: AppGroup[] = [];
  for (const app of pending) {
    if (taken.has(app.id)) continue;
    taken.add(app.id);
    // Judged against every record, so an ambiguous name never joins by the luck of the order. A sibling
    // joins only when it names this record back (mutual), and only once.
    const joined = findSiblings(pending, app).filter(
      (s) => !taken.has(s.id) && findSiblings(pending, s).some((back) => back.id === app.id),
    );
    for (const s of joined) taken.add(s.id);
    groups.push(make([app, ...joined]));
  }
  return groups;
}

/** The group that holds the record with this id. */
export const groupOf = (groups: readonly AppGroup[], id: string): AppGroup | null =>
  groups.find((g) => g.members.some((m) => m.id === id)) ?? null;
