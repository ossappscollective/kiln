import { type Platform, platformLabel } from '@mrm/core';

/**
 * The "For apps" choice of the dispatch dialog (docs/api/ci.md): a run can be started for several apps of one repository (one
 * workflow that builds an iOS and an Android app). None selected is allowed: the run is then shown on every app of the repository.
 * Pure. Written for the ES2017 web build.
 */

/** The server accepts 1 to 20 apps. */
export const MAX_DISPATCH_APPS = 20;

export type DispatchApp = { id: string; name: string; platform: Platform };

/** The id list of the request, or nothing at all when none is chosen (then no `appIds` is sent). */
export function dispatchAppsBody(selected: readonly string[]): { appIds?: string[] } {
  const unique = Array.from(new Set(selected));
  return unique.length === 0 ? {} : { appIds: unique.slice(0, MAX_DISPATCH_APPS) };
}

/** The apps to preselect: the suggested one when it belongs to the repository, else none. */
export function initialSelection(apps: readonly DispatchApp[], suggested: string): string[] {
  return suggested !== '' && apps.some((a) => a.id === suggested) ? [suggested] : [];
}

/** Adds or removes one app, keeping the order of `apps`. */
export function toggleApp(
  apps: readonly DispatchApp[],
  selected: readonly string[],
  id: string,
  on: boolean,
): string[] {
  const set = new Set(selected);
  if (on) set.add(id);
  else set.delete(id);
  return apps.filter((a) => set.has(a.id)).map((a) => a.id);
}

const label = (a: DispatchApp): string => `${a.name} (${platformLabel(a.platform)})`;

/** The line of the confirmation: who the run is for, and what "none" means. */
export function appsLine(apps: readonly DispatchApp[], selected: readonly string[]): string {
  const chosen = apps.filter((a) => selected.indexOf(a.id) >= 0);
  if (chosen.length === 0)
    return 'For no app in particular: the run is shown on every app of this repository.';
  return `For ${chosen.length === 1 ? 'the app' : 'the apps'} ${chosen.map(label).join(', ')}.`;
}

/** The short hint under the field. */
export const APPS_HINT =
  'Pick the apps this run builds. Leave it empty to show the run on every app of this repository.';
export const APPS_INFO =
  'A run tied to apps is listed on those apps, and its build is matched to theirs by the build number in its inputs. With none picked the run is not tied to any app: it is shown on every app of the repository, because there is no way to tell which one it builds.';
