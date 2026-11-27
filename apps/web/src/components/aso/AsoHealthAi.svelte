<!--
  AsoHealthAi: "ASO health report" on the ASO overview: for each app with data, one button that asks the assistant to turn what is already
  stored (the coach's next steps, the rank changes of the tracked keywords, the last 28 days of analytics) into five prioritised actions
  in plain language. A report to read: it changes nothing, and the counts in it come from our own database, not from the model. The report
  shows below the button; "Mark as reviewed" closes it. Drawn only when AI is on and the role may use it.
  Props: api, workspaceId, role, targets (the app records to offer it for).
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import { suggestAvailability } from '../../lib/ai/ai.ts';
  import { aiStore } from '../../lib/app-state/ai-facade.ts';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { appLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import AiSuggestions from '../ai/AiSuggestions.svelte';
  import SuggestButton from '../ai/SuggestButton.svelte';
  import Icon from '../ui/Icon.svelte';

  let { api, workspaceId, role, targets }: { api: Api; workspaceId: string; role: Role; targets: AppSummary[] } = $props();

  const config = $derived(aiStore.config(workspaceId));
  const visible = $derived(targets.length > 0 && suggestAvailability({ role, config, kind: 'insight' }).visible);

  async function run(app: AppSummary) {
    await aiStore.run(api, workspaceId, 'aso_health', { appId: app.id });
  }
</script>

{#if visible}
  <section class="card" aria-label={t('aso:health.title')}>
    <h2 class="h"><Icon name="sparkles" size={16} /> {t('aso:health.title')}</h2>
    <ul class="apps">
      {#each targets as app (app.id)}
        <li>
          <div class="row wrap">
            <strong>{appLabel(app)}</strong>
            <SuggestButton {api} {workspaceId} {role} kind="insight" taskId="aso_health" label={t('aso:health.write')} hiddenLabel={t('aso:health.writeFor', { app: appLabel(app) })} onrun={() => run(app)} preview={{ appId: app.id }} />
          </div>
          <AiSuggestions {api} {workspaceId} {role} {app} platform={app.platform} tasks={['aso_health']} />
        </li>
      {/each}
    </ul>
    <p class="muted hint">{t('aso:health.hint')}</p>
  </section>
{/if}

<style>
  .h {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0 0 var(--space-2);
    font-size: var(--text-md);
  }

  .apps {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .apps li {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
</style>
