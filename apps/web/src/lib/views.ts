import type { Action, Role } from '@mrm/core';
import type { Component } from 'svelte';
import Audit from '../components/Audit.svelte';
import Credentials from '../components/Credentials.svelte';
import Members from '../components/Members.svelte';
import Portfolio from '../components/Portfolio.svelte';
import Repositories from '../components/Repositories.svelte';
import type { Api } from './api.ts';

/** What the shell hands to every section. */
export type ViewProps = { api: Api; workspaceId: string; role: Role };

export type ViewDef = {
  /** Used in the URL as `#/<id>`. */
  id: string;
  label: string;
  /** A name from components/ui/icons.ts, shown beside the label in the navigation. */
  icon?: string;
  component: Component<ViewProps>;
  /** Hidden from the navigation for roles that lack this action. */
  requires?: Action;
};

/**
 * The sections of the app, in navigation order. Adding a screen means adding one entry here;
 * the shell builds its navigation and routing from this list.
 */
export const views: ViewDef[] = [
  { id: 'portfolio', icon: 'smartphone', label: 'Portfolio', component: Portfolio, requires: 'apps.read' },
  { id: 'repositories', icon: 'git-branch', label: 'Repositories', component: Repositories, requires: 'repositories.read' },
  { id: 'credentials', icon: 'key', label: 'Credentials', component: Credentials, requires: 'credentials.read' },
  { id: 'members', icon: 'users', label: 'Members', component: Members, requires: 'members.read' },
  { id: 'audit', icon: 'history', label: 'Audit log', component: Audit, requires: 'audit.read' },
];
