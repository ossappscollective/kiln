<!--
  EasSubmissionsPanel: the "EAS submissions" section of the Builds page for one app record: the stored EAS status (the server does not call Expo
  for it; the sync keeps it fresh) as the list of EasSubmissions, with the quiet freshness line (EasStatusNote). Nothing is submitted, cancelled or
  retried from here. An app that is not linked to an Expo project says so with the way to link it; a linked one with no submission says "none yet".
  While a submission is running the stored status is read again every minute.
  Props: api, workspaceId, app.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { type EasStatusView } from '../../lib/eas/eas-status.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import EmptyState from '../ui/EmptyState.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import EasStatusNote from './EasStatusNote.svelte';
  import EasSubmissions from './EasSubmissions.svelte';
  import { useNow, usePoll } from '../../lib/app-state/clock.svelte.ts';

  let { api, workspaceId, app }: { api: Api; workspaceId: string; app: AppSummary } = $props();

  let status = $state<EasStatusView | null>(null);
  let loaded = $state(false);
  const clock = useNow();
  const now = $derived(clock.value);
  let generation = 0;

  async function load() {
    const mine = ++generation;
    try {
      const read = await api.easStatus(workspaceId, app.id);
      if (mine === generation) status = read.status.project ? read.status : null;
    } catch {
      if (mine === generation) status = null;
    } finally {
      if (mine === generation) {
        loaded = true;
        clock.touch();
      }
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    untrack(() => {
      loaded = false;
      void load();
    });
  });

  usePoll(() => void load(), 60_000, { while: () => status?.active === true });
</script>

{#if !loaded}
  <Skeleton />
{:else if status === null}
  <EmptyState title={t('eas:submissions.notLinkedTitle')} description={t('eas:submissions.notLinked')} />
{:else}
  <div class="stack">
    <EasStatusNote {status} problem="" {now} />
    {#if status.submissions.length > 0}
      <EasSubmissions {status} {now} />
    {:else}
      <EmptyState title={t('eas:submissions.noneTitle')} description={t('eas:submissions.none')} />
    {/if}
  </div>
{/if}
