<!--
  EasConfigCard: the "EAS configuration" card of an app's Builds page: what eas.json of the app's repository says (build and submit
  profiles, channels, runtime version, the update setup) and what looks wrong in it. Collapsed until opened; the file is read from the
  repository only then (one read of GitHub or of the local folder, no call to Expo, no Expo credential), and again with "Read again".
  Read-only: nothing here changes the repository or Expo. Drawn only for an app with a repository and for a role that may read it
  (the right of a scan, as the other reads of the repository).
  Props: api, workspaceId, role, app (the record whose repository is read).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { collapsedSummary } from '../../lib/eas/eas-config.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, EasConfigView } from '../../lib/types.ts';
  import Section from '../ui/Section.svelte';
  import EasConfigBody from './EasConfigBody.svelte';

  let { api, workspaceId, role, app }: { api: Api; workspaceId: string; role: Role; app: AppSummary } = $props();

  const show = $derived(app.repositoryId !== null && can(role, 'repositories.scan'));

  // What the body last read, so the collapsed card can say it; the body itself is only drawn while the card is open.
  let read = $state<{ appId: string; view: EasConfigView | null; state: 'idle' | 'loading' | 'error' } | null>(null);
  const summary = $derived(read !== null && read.appId === app.id ? collapsedSummary(read.view, read.state) : collapsedSummary(null, 'idle'));
</script>

{#if show}
  <Section title={t('eas:config.card.title')} key="eas-config-{app.id}" defaultOpen={false} {summary}>
    <EasConfigBody {api} {workspaceId} {app} onread={(view, state) => (read = { appId: app.id, view, state })} />
  </Section>
{/if}
