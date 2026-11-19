import type { Action } from '@mrm/core';
import type { SectionView } from './app-nav.ts';
import { parseViewPath } from './app-scope.ts';

/**
 * The views of the workspace Settings page (`#/settings?view=security`), as pure functions like lib/app-nav.ts. The page was one long
 * list of cards; it is now four views behind the small segmented control (ViewSwitch):
 *   General   Reviews, Releases, Translation (the form with the "Save settings" bar)
 *   Analytics the opt-in, the Apple vendor number, the Play bucket (the same form)
 *   Security  confirm hard actions, recovery codes, authenticator app and email, mail
 *   AI        the AI assistant and "Connect an AI assistant"
 * `#/settings` is General and stays a valid address. General is the default and is not written. An unknown `?view=` is General.
 */

export type SettingsView = 'general' | 'analytics' | 'security' | 'ai';

export type SettingsViewDef = SectionView & { id: SettingsView };

/**
 * `requires` is the right to read the workspace settings. The AI view has none: "Connect an AI assistant" is open to every role
 * (the cards inside gate themselves).
 */
export const settingsViews: readonly SettingsViewDef[] = [
  { id: 'general', label: 'General', requires: 'settings.read' },
  { id: 'analytics', label: 'Analytics', requires: 'settings.read' },
  { id: 'security', label: 'Security', requires: 'settings.read' },
  { id: 'ai', label: 'AI' },
];

/** The views of the form that share one state and one "Save settings" bar. */
export const settingsFormViews: readonly SettingsView[] = ['general', 'analytics'];

export const isSettingsView = (value: string | null | undefined): value is SettingsView =>
  settingsViews.some((v) => v.id === value);

/** The view an address names; nothing or an unknown value is General. */
export function settingsViewOf(hash: string): SettingsView {
  const asked = parseViewPath(hash).query.get('view');
  return isSettingsView(asked) ? asked : 'general';
}

const openViews = (allowed: (action: Action) => boolean): SettingsViewDef[] =>
  settingsViews.filter((v) => !v.requires || allowed(v.requires));

/** The views a role may open, in order; empty when there is nothing to switch between (fewer than two). */
export function settingsViewsFor(allowed: (action: Action) => boolean): SettingsViewDef[] {
  const list = openViews(allowed);
  return list.length > 1 ? list : [];
}

/** The view to draw: the one the address names when the role may open it, else the first the role may open. */
export function resolveSettingsView(
  hash: string,
  allowed: (action: Action) => boolean,
): SettingsView {
  const list = openViews(allowed);
  const asked = settingsViewOf(hash);
  return list.find((v) => v.id === asked)?.id ?? list[0]?.id ?? 'general';
}

/** The same address on another view. General is the default and is not written; other query parts stay. */
export function withSettingsView(hash: string, view: string): string {
  if (!isSettingsView(view)) return hash;
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  if (view === 'general') params.delete('view');
  else params.set('view', view);
  const search = params.toString();
  return search === '' ? path : `${path}?${search}`;
}

/** Whether a view holds the settings form (so "Save settings" is drawn there). */
export const isFormView = (view: SettingsView): boolean => settingsFormViews.includes(view);

/** The views of the form with their label, for the note on another view that unsaved changes wait on. */
export const unsavedViewsNote = (view: SettingsView): string =>
  isFormView(view)
    ? ''
    : 'You have unsaved changes in General or Analytics. They stay until you save or discard them there.';
