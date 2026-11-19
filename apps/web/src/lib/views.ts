import type { Action, Role } from '@mrm/core';
import type { Component } from 'svelte';
import Alerts from '../components/Alerts.svelte';
import Audit from '../components/Audit.svelte';
import Credentials from '../components/Credentials.svelte';
import Members from '../components/Members.svelte';
import Portfolio from '../components/Portfolio.svelte';
import Repositories from '../components/Repositories.svelte';
import Settings from '../components/Settings.svelte';
import AsoOverview from '../components/aso/AsoOverview.svelte';
import ReviewsInbox from '../components/reviews/ReviewsInbox.svelte';
import Tokens from '../components/Tokens.svelte';
import Webhooks from '../components/Webhooks.svelte';
import Workflows from '../components/Workflows.svelte';
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
  /** `workspace` entries are listed under the "Workspace" heading of the left nav, the rest above it. */
  group?: 'workspace';
};

/**
 * The sections of the app, in navigation order. Adding a screen means adding one entry here;
 * the shell builds its navigation and routing from this list.
 */
export const views: ViewDef[] = [
  { id: 'portfolio', icon: 'smartphone', label: 'All apps', component: Portfolio, requires: 'apps.read' },
  { id: 'reviews', icon: 'message', label: 'Reviews inbox', component: ReviewsInbox, requires: 'reviews.read' },
  { id: 'aso', icon: 'trending-up', label: 'ASO', component: AsoOverview, requires: 'aso.read' },
  { id: 'repositories', icon: 'git-branch', label: 'Repositories', component: Repositories, requires: 'repositories.read' },
  { id: 'workflows', icon: 'play', label: 'Workflows', component: Workflows, requires: 'repositories.read' },
  { id: 'credentials', group: 'workspace', icon: 'key', label: 'Credentials', component: Credentials, requires: 'credentials.read' },
  { id: 'members', group: 'workspace', icon: 'users', label: 'Members', component: Members, requires: 'members.read' },
  { id: 'tokens', group: 'workspace', icon: 'shield', label: 'API tokens', component: Tokens, requires: 'tokens.read' },
  { id: 'webhooks', group: 'workspace', icon: 'globe', label: 'Webhooks', component: Webhooks, requires: 'webhooks.read' },
  { id: 'alerts', group: 'workspace', icon: 'bell', label: 'Alerts', component: Alerts, requires: 'alerts.read' },
  { id: 'settings', group: 'workspace', icon: 'settings', label: 'Settings', component: Settings, requires: 'settings.read' },
  { id: 'audit', group: 'workspace', icon: 'history', label: 'Audit log', component: Audit, requires: 'audit.read' },
];
