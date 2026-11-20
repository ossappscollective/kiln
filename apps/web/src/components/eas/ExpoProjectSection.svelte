<!--
  ExpoProjectSection: the "Expo project" card of the app Settings (docs/adr/0033-eas-integration.md): which EAS project each record of
  the app belongs to, and which Expo credential reads it. It is drawn only when it can matter (a record is linked, the workspace has an
  Expo credential, or the repository is an Expo project); an app that never touches Expo carries no card. Linking changes nothing in Expo.
  Props: api, workspaceId, role, members (the records in scope), now.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type ExpoLinkView, expoCredentials, expoSummary, showExpoCard } from '../../lib/eas/eas.ts';
  import type { AppSummary, CredentialSummary, RepositorySummary } from '../../lib/types.ts';
  import SettingsCard from '../app/settings/SettingsCard.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import EasWorkflowsCard from './EasWorkflowsCard.svelte';
  import ExpoProjectField from './ExpoProjectField.svelte';

  let { api, workspaceId, role, members, now }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number } = $props();

  let links = $state<Record<string, ExpoLinkView | null | undefined>>({});
  let credentials = $state<CredentialSummary[] | null>(null);
  let repositories = $state<RepositorySummary[]>([]);
  let loaded = $state(false);

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);

  $effect(() => {
    const space = workspaceId;
    const apps = members.map((m) => m.id);
    const wantsRepositories = can(role, 'repositories.read') && members.some((m) => m.repositoryId !== null);
    void key;
    untrack(() => {
      links = {};
      credentials = null;
      repositories = [];
      loaded = false;
    });
    let current = true;
    const reads: Promise<unknown>[] = [
      ...apps.map((id) =>
        api
          .expoLink(space, id)
          .then((r) => {
            if (current) links = { ...links, [id]: r.link };
          })
          .catch(() => {}),
      ),
    ];
    if (can(role, 'credentials.read')) {
      reads.push(
        api
          .credentials(space)
          .then((r) => {
            if (current) credentials = r.credentials;
          })
          .catch(() => {}),
      );
    }
    if (wantsRepositories) {
      reads.push(
        api
          .repositories(space)
          .then((r) => {
            if (current) repositories = r.repositories;
          })
          .catch(() => {}),
      );
    }
    void Promise.all(reads).then(() => {
      if (current) loaded = true;
    });
    return () => {
      current = false;
    };
  });

  const linkOf = (app: AppSummary): ExpoLinkView | null => links[app.id] ?? null;
  const allLinks = $derived(members.map((m) => links[m.id] ?? null));
  const repositoryKinds = $derived(members.map((m) => repositories.filter((r) => r.id === m.repositoryId)[0]?.projectKind ?? null));
  const show = $derived(loaded && showExpoCard({ links: allLinks, expoCredentialCount: expoCredentials(credentials).length, repositoryKinds }));
</script>

{#if show}
  <SettingsCard
    title="Expo project"
    icon="code"
    description="The Expo (EAS) project this app is built with. Linking only lets this tool read it; nothing in Expo is changed."
    summary={expoSummary(allLinks)}
  >
    {#each members as app (app.id)}
      <section class="stack tight" aria-label="{app.platform} Expo project">
        {#if members.length > 1}<PlatformBadge platform={app.platform} />{/if}
        <ExpoProjectField
          {api}
          {workspaceId}
          {role}
          {app}
          link={linkOf(app)}
          siblings={members.filter((m) => m.id !== app.id).map(linkOf)}
          {credentials}
          {now}
          onchanged={(next) => (links = { ...links, [app.id]: next })}
        />
        {#if linkOf(app)}
          <EasWorkflowsCard {api} {workspaceId} {role} {app} link={linkOf(app) as ExpoLinkView} {now} />
        {/if}
      </section>
    {/each}
  </SettingsCard>
{/if}
