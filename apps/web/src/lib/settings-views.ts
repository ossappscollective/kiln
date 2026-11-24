import type { Action } from '@kiln/core';
import { parseViewPath } from './app-scope.ts';
import { k, t } from './i18n/t.ts';

/**
 * The sections of the workspace Settings page (`#/settings?section=reviews`), as pure functions like lib/app-nav.ts. The page is a
 * list of sections in a rail on the left (grouped, with a search) and one section at a time on the right, like the preferences of
 * Slack and VS Code. The old addresses stay valid: `?view=general|analytics|security|ai` opens the first section of that old view.
 *
 *   Workspace     Store refresh, Reviews, Releases, Translation, Analytics   (one form, one "Save settings" bar)
 *   Just for you  Language                                                   (this browser; applies at once)
 *   Security      Confirm hard actions, Authenticator and email, Mail server
 *   AI            AI assistant, Connect an AI assistant
 *   Integrations  Slack and Teams (drawn here; `#/chat` is the same screen), Webhooks (a link to its page)
 */

export type SettingsGroup = 'workspace' | 'personal' | 'security' | 'ai' | 'integrations';

export type SettingsSectionId =
  | 'store-refresh'
  | 'reviews'
  | 'releases'
  | 'translation'
  | 'analytics'
  | 'language'
  | 'confirm'
  | 'second-factor'
  | 'mail'
  | 'ai'
  | 'mcp'
  | 'chat'
  | 'webhooks';

/** `form`: part of the settings form (the save bar is drawn). `page`: a section with its own save. `link`: opens another page. */
export type SettingsSectionKind = 'form' | 'page' | 'link';

type SectionKeyDef = {
  id: SettingsSectionId;
  group: SettingsGroup;
  labelKey: string;
  /** The words a search also matches (a message with the terms of the section, space separated). */
  keywordsKey: string;
  kind: SettingsSectionKind;
  /** The right needed to see it; none means every role. */
  requires?: Action;
  /** For a link: the address it opens. */
  href?: string;
};

export const settingsSections: readonly SectionKeyDef[] = [
  {
    id: 'store-refresh',
    group: 'workspace',
    labelKey: k('settings:section.storeRefresh'),
    keywordsKey: k('settings:keywords.storeRefresh'),
    kind: 'form',
    requires: 'settings.read',
  },
  {
    id: 'reviews',
    group: 'workspace',
    labelKey: k('settings:section.reviews'),
    keywordsKey: k('settings:keywords.reviews'),
    kind: 'form',
    requires: 'settings.read',
  },
  {
    id: 'releases',
    group: 'workspace',
    labelKey: k('settings:section.releases'),
    keywordsKey: k('settings:keywords.releases'),
    kind: 'form',
    requires: 'settings.read',
  },
  {
    id: 'translation',
    group: 'workspace',
    labelKey: k('settings:section.translation'),
    keywordsKey: k('settings:keywords.translation'),
    kind: 'form',
    requires: 'settings.read',
  },
  {
    id: 'analytics',
    group: 'workspace',
    labelKey: k('settings:section.analytics'),
    keywordsKey: k('settings:keywords.analytics'),
    kind: 'form',
    requires: 'settings.read',
  },
  {
    id: 'language',
    group: 'personal',
    labelKey: k('settings:section.language'),
    keywordsKey: k('settings:keywords.language'),
    kind: 'page',
  },
  {
    id: 'confirm',
    group: 'security',
    labelKey: k('settings:section.confirm'),
    keywordsKey: k('settings:keywords.confirm'),
    kind: 'page',
    requires: 'settings.read',
  },
  {
    id: 'second-factor',
    group: 'security',
    labelKey: k('settings:section.secondFactor'),
    keywordsKey: k('settings:keywords.secondFactor'),
    kind: 'page',
    requires: 'settings.read',
  },
  {
    id: 'mail',
    group: 'security',
    labelKey: k('settings:section.mail'),
    keywordsKey: k('settings:keywords.mail'),
    kind: 'page',
    requires: 'settings.write',
  },
  {
    id: 'ai',
    group: 'ai',
    labelKey: k('settings:section.ai'),
    keywordsKey: k('settings:keywords.ai'),
    kind: 'page',
    requires: 'ai.use',
  },
  {
    id: 'mcp',
    group: 'ai',
    labelKey: k('settings:section.mcp'),
    keywordsKey: k('settings:keywords.mcp'),
    kind: 'page',
  },
  {
    id: 'chat',
    group: 'integrations',
    labelKey: k('settings:section.chat'),
    keywordsKey: k('settings:keywords.chat'),
    kind: 'page',
    requires: 'chat.read',
  },
  {
    id: 'webhooks',
    group: 'integrations',
    labelKey: k('settings:section.webhooks'),
    keywordsKey: k('settings:keywords.webhooks'),
    kind: 'link',
    requires: 'webhooks.read',
    href: '#/webhooks',
  },
];

const groupLabelKeys: Record<SettingsGroup, string> = {
  workspace: k('settings:group.workspace'),
  personal: k('settings:group.personal'),
  security: k('settings:group.security'),
  ai: k('settings:group.ai'),
  integrations: k('settings:group.integrations'),
};

const groupOrder: readonly SettingsGroup[] = [
  'workspace',
  'personal',
  'security',
  'ai',
  'integrations',
];

export type SettingsSectionDef = {
  id: SettingsSectionId;
  label: string;
  keywords: string;
  kind: SettingsSectionKind;
  href?: string;
};

export type SettingsGroupDef = { id: SettingsGroup; label: string; items: SettingsSectionDef[] };

const isSection = (value: string | null | undefined): value is SettingsSectionId =>
  settingsSections.some((s) => s.id === value);

/** The sections a role may see, grouped in order; a group with nothing in it is left out. */
export function settingsGroupsFor(allowed: (action: Action) => boolean): SettingsGroupDef[] {
  return groupOrder
    .map((group) => ({
      id: group,
      label: t(groupLabelKeys[group]),
      items: settingsSections
        .filter((s) => s.group === group && (!s.requires || allowed(s.requires)))
        .map((s) => ({
          id: s.id,
          label: t(s.labelKey),
          keywords: t(s.keywordsKey),
          kind: s.kind,
          ...(s.href ? { href: s.href } : {}),
        })),
    }))
    .filter((g) => g.items.length > 0);
}

/** The groups narrowed by a search: a section stays when its name, its group's name or its keywords have the text in it (case and accents ignored). */
export function filterSettingsGroups(
  groups: readonly SettingsGroupDef[],
  query: string,
): SettingsGroupDef[] {
  const needle = fold(query);
  if (needle === '') return [...groups];
  return groups
    .map((g) => ({
      ...g,
      items: fold(g.label).includes(needle)
        ? g.items
        : g.items.filter((i) => fold(`${i.label} ${i.keywords}`).includes(needle)),
    }))
    .filter((g) => g.items.length > 0);
}

const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** What the old `?view=` addresses open now (emails and other pages still link to them). */
const legacyView: Record<string, SettingsSectionId> = {
  general: 'store-refresh',
  analytics: 'analytics',
  security: 'confirm',
  ai: 'ai',
};

/** The section an address names (a link section never is the current one); null when it names none. */
export function settingsSectionOf(hash: string): SettingsSectionId | null {
  const query = parseViewPath(hash).query;
  const asked = query.get('section');
  if (isSection(asked)) return asked;
  const old = query.get('view');
  return old ? (legacyView[old] ?? null) : null;
}

/** The section to draw: the one the address names when the role may open it, else the first the role may open. */
export function resolveSettingsSection(
  hash: string,
  allowed: (action: Action) => boolean,
): SettingsSectionId {
  const open = settingsSections.filter(
    (s) => s.kind !== 'link' && (!s.requires || allowed(s.requires)),
  );
  const asked = settingsSectionOf(hash);
  return open.find((s) => s.id === asked)?.id ?? open[0]?.id ?? 'language';
}

/** The same address on another section; the old `view` is dropped and other query parts stay. */
export function withSettingsSection(hash: string, section: string): string {
  if (!isSection(section)) return hash;
  const at = hash.indexOf('?');
  const path = at < 0 ? hash : hash.slice(0, at);
  const params = new URLSearchParams(at < 0 ? '' : hash.slice(at + 1));
  params.delete('view');
  params.set('section', section);
  return `${path}?${params.toString()}`;
}

/** Whether a section is part of the settings form (so "Save settings" is drawn there). */
export const isFormSection = (section: SettingsSectionId): boolean =>
  settingsSections.some((s) => s.id === section && s.kind === 'form');

/** One part of a page the person can jump to: `id` is the element id of its wrapper on the page (the "Jump to" row of the app settings). */
export type SettingsSection = { id: string; label: string };
