<!--
  AlertRules: the workspace defaults for every alert type (admins). People then choose their own channels within what each type
  allows. Props: api, workspaceId, catalog, onsaved (reload the catalog).
-->
<script lang="ts">
  import { type CatalogEntry, matrixGroups } from '../../lib/alerts/alerts.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Section from '../ui/Section.svelte';
  import AlertRuleRow from './AlertRuleRow.svelte';

  import type { Api } from '../../lib/api.ts';

  let { api, workspaceId, catalog, onsaved }: { api: Api; workspaceId: string; catalog: CatalogEntry[]; onsaved: () => void } = $props();

  // Admins see every type, including the ones a viewer never receives.
  const groups = $derived(matrixGroups(catalog.map((e) => ({ ...e, visible: true }))));
</script>

<div class="stack">
  <p class="muted">{t('workspace:alerts.rules.intro')}</p>
  {#each groups as g (g.id)}
    <Section title={g.label} key={`alerts-rules-${g.id}`} count={g.entries.length} defaultOpen={false}>
      {#each g.entries as e (e.id)}
        <AlertRuleRow {api} {workspaceId} entry={e} onsaved={onsaved} />
      {/each}
    </Section>
  {/each}
</div>
