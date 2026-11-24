import type { Action, Role } from '@kiln/core';
import type { Component } from 'svelte';
import Alerts from '../components/Alerts.svelte';
import Audit from '../components/Audit.svelte';
import Chat from '../components/Chat.svelte';
import AsoOverview from '../components/aso/AsoOverview.svelte';
import Credentials from '../components/Credentials.svelte';
import Members from '../components/Members.svelte';
import Portfolio from '../components/Portfolio.svelte';
import Repositories from '../components/Repositories.svelte';
import ReviewsInbox from '../components/reviews/ReviewsInbox.svelte';
import WorkspacePending from '../components/pending/WorkspacePending.svelte';
import Settings from '../components/Settings.svelte';
import Tokens from '../components/Tokens.svelte';
import Webhooks from '../components/Webhooks.svelte';
import Workflows from '../components/Workflows.svelte';
import type { Api } from './api.ts';
import { k } from './i18n/t.ts';

/** What the shell hands to every section. */
export type ViewProps = { api: Api; workspaceId: string; role: Role };

export type ViewDef = {
  /** Used in the URL as `#/<id>`. */
  id: string;
  /** The message key of the name in the navigation (translate with `t()` where it is drawn: this list is built once). */
  labelKey: string;
  /** A shorter name for the navigation only (same as the app-level group); the page title and breadcrumb use `labelKey`. */
  navLabelKey?: string;
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
  {
    id: 'portfolio',
    icon: 'smartphone',
    labelKey: k('shell:nav.allApps'),
    component: Portfolio,
    requires: 'apps.read',
  },
  {
    id: 'reviews',
    icon: 'message',
    labelKey: k('shell:nav.reviews'),
    navLabelKey: k('app:rail.inbox'),
    component: ReviewsInbox,
    requires: 'reviews.read',
  },
  {
    id: 'pending',
    icon: 'upload',
    labelKey: k('shell:nav.pending'),
    navLabelKey: k('app:rail.pending'),
    component: WorkspacePending,
    requires: 'listing.read',
  },
  {
    id: 'aso',
    icon: 'trending-up',
    labelKey: k('shell:nav.aso'),
    component: AsoOverview,
    requires: 'aso.read',
  },
  {
    id: 'repositories',
    icon: 'git-branch',
    labelKey: k('shell:nav.repositories'),
    component: Repositories,
    requires: 'repositories.read',
  },
  {
    id: 'workflows',
    icon: 'play',
    labelKey: k('shell:nav.workflows'),
    component: Workflows,
    requires: 'repositories.read',
  },
  {
    id: 'credentials',
    group: 'workspace',
    icon: 'key',
    labelKey: k('shell:nav.credentials'),
    component: Credentials,
    requires: 'credentials.read',
  },
  {
    id: 'members',
    group: 'workspace',
    icon: 'users',
    labelKey: k('shell:nav.members'),
    component: Members,
    requires: 'members.read',
  },
  {
    id: 'tokens',
    group: 'workspace',
    icon: 'shield',
    labelKey: k('shell:nav.apiTokens'),
    component: Tokens,
    requires: 'tokens.read',
  },
  {
    id: 'webhooks',
    group: 'workspace',
    icon: 'globe',
    labelKey: k('shell:nav.webhooks'),
    component: Webhooks,
    requires: 'webhooks.read',
  },
  {
    id: 'chat',
    group: 'workspace',
    icon: 'message',
    labelKey: k('shell:nav.chat'),
    component: Chat,
    requires: 'chat.read',
  },
  {
    id: 'alerts',
    group: 'workspace',
    icon: 'bell',
    labelKey: k('shell:nav.alerts'),
    component: Alerts,
    requires: 'alerts.read',
  },
  {
    id: 'settings',
    group: 'workspace',
    icon: 'settings',
    labelKey: k('shell:nav.settings'),
    component: Settings,
    requires: 'settings.read',
  },
  {
    id: 'audit',
    group: 'workspace',
    icon: 'history',
    labelKey: k('shell:nav.auditLog'),
    component: Audit,
    requires: 'audit.read',
  },
];
