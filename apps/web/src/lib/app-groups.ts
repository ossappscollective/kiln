import { findSibling } from './release.ts';
import { sortApps } from './portfolio.ts';
import type { AppSummary } from './types.ts';

/**
 * One product as people see it: the iOS app and the Android app that are the same product (the same
 * identifier, else the same name) merged. Each store keeps its own record in the data model, so a
 * group only pairs them in the web layer.
 */
export type AppGroup = {
  /** The id of the first record (iOS when there is one). Stable while the records stay. */
  key: string;
  name: string;
  ios: AppSummary | null;
  android: AppSummary | null;
  /** iOS first. */
  members: AppSummary[];
};

const make = (members: AppSummary[]): AppGroup => {
  const ios = members.find((m) => m.platform === 'ios') ?? null;
  const android = members.find((m) => m.platform === 'android') ?? null;
  const ordered = [ios, android].filter((m): m is AppSummary => m !== null);
  const first = ordered[0] as AppSummary;
  return { key: first.id, name: first.name, ios, android, members: ordered };
};

/** Pairs apps into groups, sorted by name. A record with no safe partner is a group of one. */
export function groupApps(apps: readonly AppSummary[]): AppGroup[] {
  const pending = sortApps(apps);
  const taken = new Set<string>();
  const groups: AppGroup[] = [];
  for (const app of pending) {
    if (taken.has(app.id)) continue;
    taken.add(app.id);
    // Judged against every record, so an ambiguous name never pairs by the luck of the order.
    const sibling = findSibling(pending, app);
    const mutual = sibling !== null && !taken.has(sibling.id) && findSibling(pending, sibling)?.id === app.id;
    if (sibling && mutual) {
      taken.add(sibling.id);
      groups.push(make([app, sibling]));
    } else {
      groups.push(make([app]));
    }
  }
  return groups;
}

/** The group that holds the record with this id. */
export const groupOf = (groups: readonly AppGroup[], id: string): AppGroup | null =>
  groups.find((g) => g.members.some((m) => m.id === id)) ?? null;
