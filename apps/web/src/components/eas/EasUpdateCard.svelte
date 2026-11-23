<!--
  EasUpdateCard: the "EAS Update" card of an app's Builds page: the update channels of the Expo project the app is linked to, the branch each
  points to, the newest updates, rollouts that are in progress, insights of an update group, and a warning for a channel whose newest update
  would not reach the binaries that were shipped (runtime version mismatch). Drawn only for an app that is linked to an Expo project (the link
  is read from the database, Expo is not asked); collapsed until opened, and Expo is asked only then and on "Read again".
  Raising a rollout is off unless the server allows it (docs/adr/0037-eas-update.md); everything else is read-only.
  Props: api, workspaceId, role, app (the record whose Expo project is read), defaultOpen? (open on first draw: the section rail opens it).
-->
<script lang="ts">
  import { type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type EasUpdateState, updateSummary } from '../../lib/eas/eas-update.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Section from '../ui/Section.svelte';
  import EasUpdateBody from './EasUpdateBody.svelte';

  let { api, workspaceId, role, app, defaultOpen = false }: { api: Api; workspaceId: string; role: Role; app: AppSummary; defaultOpen?: boolean | undefined } = $props();

  // Whether the app is linked (null until the link is read). The link is in the database: no call to Expo.
  let linked = $state<boolean | null>(null);
  let generation = 0;

  $effect(() => {
    void app.id;
    void workspaceId;
    untrack(() => {
      const mine = ++generation;
      linked = null;
      read = null;
      api
        .expoLink(workspaceId, app.id)
        .then((r) => {
          if (mine === generation) linked = r.link !== null && r.link.credentialAvailable;
        })
        .catch(() => {
          if (mine === generation) linked = false;
        });
    });
  });

  // What the body last read, so the collapsed card can say it; the body itself is only drawn while the card is open.
  let read = $state<{ appId: string; state: EasUpdateState | null; loading: boolean } | null>(null);
  const summary = $derived(read !== null && read.appId === app.id ? updateSummary(read.state, read.loading) : updateSummary(null, false));
</script>

{#if linked === true}
  <Section title={t('eas:update.card.title')} key="eas-update-{app.id}" {defaultOpen} {summary}>
    <EasUpdateBody {api} {workspaceId} {role} {app} onread={(state, loading) => (read = { appId: app.id, state, loading })} />
  </Section>
{/if}
