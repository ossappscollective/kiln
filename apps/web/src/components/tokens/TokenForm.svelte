<script lang="ts">
  import { type Role, type TokenRole } from '@kiln/core';
  import { onMount } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    type ExpiryChoice,
    actionLabel,
    ceilingsFor,
    createInput,
    expiryChoices,
    narrowableActions,
    tokenRoleHelp,
    tokenRoleLabel,
    validateTokenForm,
  } from '../../lib/api-tokens.ts';
  import { t } from '../../lib/i18n/t.ts';
  import type { AppSummary, CreatedApiToken } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import AppIcon from '../ui/AppIcon.svelte';
  import Button from '../ui/Button.svelte';
  import TextField from '../ui/TextField.svelte';

  let {
    api,
    workspaceId,
    role,
    apps,
    oncreated,
    oncancel,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    /** The apps a token can be limited to. Null while loading or when they could not be loaded. */
    apps: AppSummary[] | null;
    oncreated: (created: CreatedApiToken) => void;
    oncancel: () => void;
  } = $props();

  const uid = $props.id();
  const ceilings = $derived(ceilingsFor(role));

  let name = $state('');
  let chosenRole = $state<TokenRole>('viewer');
  let expiry = $state<ExpiryChoice>('90d');
  let limitApps = $state(false);
  let appIds = $state<string[]>([]);
  let limitActions = $state(false);
  let actions = $state<string[]>([]);
  let busy = $state(false);
  let error = $state('');
  let showProblems = $state(false);

  const ceiling = $derived(ceilings.includes(chosenRole) ? chosenRole : (ceilings[ceilings.length - 1] ?? 'viewer'));
  const available = $derived(narrowableActions(ceiling));
  // Actions that the chosen role does not allow are dropped when the role changes.
  const keptActions = $derived(actions.filter((a) => available.includes(a as never)));
  const form = $derived({
    name,
    role: ceiling,
    expiry,
    appIds: limitApps ? appIds : [],
    actions: limitActions ? keptActions : [],
  });
  const problems = $derived(validateTokenForm(form));
  const needsApps = $derived(limitApps && appIds.length === 0);
  const needsActions = $derived(limitActions && keptActions.length === 0);

  onMount(() => document.getElementById(`${uid}-name`)?.focus());

  function toggle(list: string[], value: string, on: boolean): string[] {
    return on ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    showProblems = true;
    if (problems.name || problems.actions || needsApps || needsActions) return;
    busy = true;
    error = '';
    try {
      oncreated(await api.createApiToken(workspaceId, createInput(form)));
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('common:error.genericRetry');
    } finally {
      busy = false;
    }
  }
</script>

<form class="card" onsubmit={submit} novalidate>
  <div class="card-header">
    <div>
      <h3>{t('workspace:tokens.form.title')}</h3>
      <p>{t('workspace:tokens.form.description')}</p>
    </div>
  </div>

  <div class="stack">
    <TextField
      label={t('workspace:tokens.form.name')}
      id="{uid}-name"
      bind:value={name}
      maxlength={100}
      autocomplete="off"
      placeholder={t('workspace:tokens.form.namePlaceholder')}
      hint={t('workspace:tokens.form.nameHint')}
      error={showProblems ? problems.name : undefined}
    />

    <div class="grid">
      <div class="field">
        <label for="{uid}-role">{t('workspace:tokens.form.ceiling')}</label>
        <select id="{uid}-role" value={ceiling} onchange={(e) => (chosenRole = e.currentTarget.value as TokenRole)}>
          {#each ceilings as r (r)}<option value={r}>{t(tokenRoleLabel[r])}</option>{/each}
        </select>
        <p class="hint">{t(tokenRoleHelp[ceiling])}</p>
      </div>
      <div class="field">
        <label for="{uid}-expiry">{t('workspace:tokens.form.expires')}</label>
        <select id="{uid}-expiry" value={expiry} onchange={(e) => (expiry = e.currentTarget.value as ExpiryChoice)}>
          {#each expiryChoices as c (c.id)}<option value={c.id}>{t(c.labelKey)}</option>{/each}
        </select>
        <p class="hint">{t('workspace:tokens.form.expiresHint')}</p>
      </div>
    </div>

    <fieldset class="limit">
      <legend>{t('workspace:tokens.form.appsLegend')}</legend>
      <label class="check">
        <input type="checkbox" bind:checked={limitApps} disabled={apps === null || apps.length === 0} />
        <span>{t('workspace:tokens.form.onlySomeApps')}</span>
      </label>
      {#if apps === null}
        <p class="hint">{t('workspace:tokens.form.appsNotLoaded')}</p>
      {:else if apps.length === 0}
        <p class="hint">{t('workspace:tokens.form.noApps')}</p>
      {:else if !limitApps}
        <p class="hint">{t('workspace:tokens.form.allApps')}</p>
      {:else}
        <div class="choices" role="group" aria-label={t('workspace:tokens.form.appsGroup')}>
          {#each apps as app (app.id)}
            <label class="check">
              <input
                type="checkbox"
                checked={appIds.includes(app.id)}
                onchange={(e) => (appIds = toggle(appIds, app.id, e.currentTarget.checked))}
              />
              <AppIcon name={app.name} url={app.iconUrl} platform={app.platform} seed={app.id} size="sm" />
              <span>{app.name} <span class="muted mono text-xs">{app.identifier}</span></span>
            </label>
          {/each}
        </div>
        {#if showProblems && needsApps}<p class="field-error" role="alert">{t('workspace:tokens.form.needsApps')}</p>{/if}
        <p class="hint">{t('workspace:tokens.form.appLimitedHint')}</p>
      {/if}
    </fieldset>

    <fieldset class="limit">
      <legend>{t('workspace:tokens.form.actionsLegend')}</legend>
      <label class="check">
        <input type="checkbox" bind:checked={limitActions} />
        <span>{t('workspace:tokens.form.onlySomeActions')}</span>
      </label>
      {#if !limitActions}
        <p class="hint">{t('workspace:tokens.form.allActions')}</p>
      {:else}
        <div class="choices" role="group" aria-label={t('workspace:tokens.form.actionsGroup')}>
          {#each available as action (action)}
            <label class="check">
              <input
                type="checkbox"
                checked={actions.includes(action)}
                onchange={(e) => (actions = toggle(actions, action, e.currentTarget.checked))}
              />
              <span>{actionLabel(action)} <span class="muted mono text-xs">{action}</span></span>
            </label>
          {/each}
        </div>
        {#if showProblems && (needsActions || problems.actions)}
          <p class="field-error" role="alert">{problems.actions ?? t('workspace:tokens.form.needsActions')}</p>
        {/if}
      {/if}
    </fieldset>

    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <div class="row actions">
      <Button type="submit" variant="primary" loading={busy}>{busy ? t('workspace:tokens.form.creating') : t('workspace:tokens.form.create')}</Button>
      <Button onclick={oncancel} disabled={busy}>{t('common:action.cancel')}</Button>
    </div>
  </div>
</form>

<style>
  .grid {
    display: grid;
    gap: 12px 16px;
    grid-template-columns: 1fr 1fr;
  }

  .limit {
    padding: 0;
    margin: 0;
    border: 0;
  }

  .limit legend {
    padding: 0;
    margin-bottom: 6px;
    font-weight: 600;
  }

  .choices {
    display: grid;
    gap: 6px;
    max-height: 240px;
    padding: 10px 12px;
    margin-top: 8px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .actions {
    margin-top: 4px;
  }

  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
