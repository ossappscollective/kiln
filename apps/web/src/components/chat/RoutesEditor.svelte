<!--
  RoutesEditor: the routing rules of one destination: which alert types, from which severity, for which apps and platforms. An alert
  goes to the destination when any rule that is on takes it. The alert types come from the alert catalog (grouped as in the Alerts
  screen), so a new alert type appears here without a change.
-->
<script lang="ts">
  import { type Api, ApiError } from '../../lib/api.ts';
  import type { CatalogEntry } from '../../lib/alerts/alerts.ts';
  import {
    type ChatDestination,
    type RouteForm,
    defaultRouteForms,
    emptyRouteForm,
    groupState,
    platformChoices,
    routeFormFrom,
    routeInputFrom,
    routeProblem,
    severityChoices,
    toggleGroup,
    typeGroups,
  } from '../../lib/chat/chat.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';

  let {
    api,
    workspaceId,
    destination,
    catalog,
    apps,
    onsaved,
    oncancel,
  }: {
    api: Api;
    workspaceId: string;
    destination: ChatDestination;
    catalog: CatalogEntry[];
    apps: AppSummary[];
    onsaved: (destination: ChatDestination) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  const groups = $derived(typeGroups(catalog));
  const initialRules = (() => destination.routes.map(routeFormFrom))();
  let rules = $state<RouteForm[]>(initialRules);
  let busy = $state(false);
  let error = $state('');
  let showProblems = $state(false);

  const labelOf = (id: string) => catalog.find((c) => c.id === id)?.label ?? id;
  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...new Set([...list, value])] : list.filter((v) => v !== value);

  async function save() {
    showProblems = true;
    if (rules.some((r) => routeProblem(r))) return;
    busy = true;
    error = '';
    try {
      const done = await api.setChatRoutes(workspaceId, destination.id, rules.map(routeInputFrom));
      onsaved(done.destination);
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('chat:routes.errors.saveFailed');
    } finally {
      busy = false;
    }
  }
</script>

<div class="card" role="region" aria-label={t('chat:routes.title')}>
  <div class="card-header">
    <div>
      <h3>{t('chat:routes.title')}</h3>
      <p>{t('chat:routes.description', { name: destination.name })}</p>
    </div>
  </div>

  <div class="stack">
    {#if rules.length === 0}<p class="muted">{t('chat:routes.noRules')}</p>{/if}

    {#each rules as rule, i (i)}
      {@const problem = showProblems ? routeProblem(rule) : undefined}
      <fieldset class="rule">
        <legend>{t('chat:routes.rule', { n: i + 1 })}</legend>

        <label class="check">
          <input type="checkbox" bind:checked={rule.allTypes} />
          <span>{t('chat:routes.allTypesLabel')}</span>
        </label>
        {#if !rule.allTypes}
          <div class="groups" role="group" aria-label={t('chat:routes.types')}>
            {#each groups as group (group.id)}
              {@const state = groupState(rule.types, group)}
              <details>
                <summary>
                  <label class="check">
                    <input
                      type="checkbox"
                      checked={state === 'all'}
                      indeterminate={state === 'some'}
                      onchange={(e) => (rule.types = toggleGroup(rule.types, group, e.currentTarget.checked))}
                    />
                    <span>{group.label}</span>
                  </label>
                </summary>
                <div class="types">
                  {#each group.types as type (type.id)}
                    <label class="check">
                      <input type="checkbox" checked={rule.types.includes(type.id)} onchange={(e) => (rule.types = toggle(rule.types, type.id, e.currentTarget.checked))} />
                      <span>{labelOf(type.id)}</span>
                    </label>
                  {/each}
                </div>
              </details>
            {/each}
          </div>
          {#if problem}<p class="field-error" role="alert">{problem}</p>{/if}
        {/if}

        <div class="field">
          <label for="{uid}-sev-{i}">{t('chat:routes.minSeverity')}</label>
          <select id="{uid}-sev-{i}" bind:value={rule.minSeverity}>
            {#each severityChoices as s (s.id)}<option value={s.id}>{t(s.fromKey)}</option>{/each}
          </select>
        </div>

        <label class="check">
          <input type="checkbox" bind:checked={rule.allApps} />
          <span>{t('chat:routes.allAppsLabel')}</span>
        </label>
        {#if !rule.allApps}
          <div class="types" role="group" aria-label={t('chat:routes.apps')}>
            {#each apps as app (app.id)}
              <label class="check">
                <input type="checkbox" checked={rule.appIds.includes(app.id)} onchange={(e) => (rule.appIds = toggle(rule.appIds, app.id, e.currentTarget.checked))} />
                <span>{app.name}</span>
              </label>
            {/each}
          </div>
        {/if}

        <label class="check">
          <input type="checkbox" bind:checked={rule.allPlatforms} />
          <span>{t('chat:routes.allPlatformsLabel')}</span>
        </label>
        {#if !rule.allPlatforms}
          <div class="types" role="group" aria-label={t('chat:routes.platforms')}>
            {#each platformChoices as p (p.id)}
              <label class="check">
                <input type="checkbox" checked={rule.platforms.includes(p.id)} onchange={(e) => (rule.platforms = toggle(rule.platforms, p.id, e.currentTarget.checked))} />
                <span>{p.label}</span>
              </label>
            {/each}
          </div>
        {/if}

        <div class="row">
          <label class="check">
            <input type="checkbox" bind:checked={rule.enabled} />
            <span>{t('chat:routes.enabled')}</span>
          </label>
          <span class="spacer"></span>
          <Button size="sm" variant="danger" label={t('chat:routes.removeLabel', { n: i + 1 })} onclick={() => (rules = rules.filter((_, at) => at !== i))}>{t('chat:routes.remove')}</Button>
        </div>
      </fieldset>
    {/each}

    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <div class="row actions">
      <Button variant="primary" loading={busy} onclick={save}>{busy ? t('chat:routes.saving') : t('chat:routes.save')}</Button>
      <Button disabled={busy} onclick={() => (rules = [...rules, emptyRouteForm()])} icon="plus">{t('chat:routes.add')}</Button>
      <Button disabled={busy} onclick={() => (rules = defaultRouteForms(catalog))}>{t('chat:routes.defaults')}</Button>
      <span class="spacer"></span>
      <Button disabled={busy} onclick={oncancel}>{t('common:action.cancel')}</Button>
    </div>
  </div>
</div>

<style>
  .rule {
    display: grid;
    gap: 10px;
    padding: 12px;
    margin: 0;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .rule legend {
    padding: 0 6px;
    font-weight: 600;
  }

  .groups {
    display: grid;
    gap: 6px;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .types {
    display: grid;
    gap: 6px;
    padding: 8px 0 0 24px;
  }

  summary {
    cursor: pointer;
  }

  .actions {
    margin-top: 4px;
  }
</style>
