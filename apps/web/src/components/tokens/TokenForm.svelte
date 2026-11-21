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
      error = e instanceof ApiError ? e.message : 'Something went wrong. Try again.';
    } finally {
      busy = false;
    }
  }
</script>

<form class="card" onsubmit={submit} novalidate>
  <div class="card-header">
    <div>
      <h3>New API token</h3>
      <p>
        For a script or CI job. It acts for you with the limits you set here, and you can revoke it at
        any time. It can never manage tokens, people, webhooks or secrets.
      </p>
    </div>
  </div>

  <div class="stack">
    <TextField
      label="Name"
      id="{uid}-name"
      bind:value={name}
      maxlength={100}
      autocomplete="off"
      placeholder="Release CI"
      hint="Something that tells you what uses it."
      error={showProblems ? problems.name : undefined}
    />

    <div class="grid">
      <div class="field">
        <label for="{uid}-role">Role ceiling</label>
        <select id="{uid}-role" value={ceiling} onchange={(e) => (chosenRole = e.currentTarget.value as TokenRole)}>
          {#each ceilings as r (r)}<option value={r}>{tokenRoleLabel[r]}</option>{/each}
        </select>
        <p class="hint">{tokenRoleHelp[ceiling]}</p>
      </div>
      <div class="field">
        <label for="{uid}-expiry">Expires</label>
        <select id="{uid}-expiry" value={expiry} onchange={(e) => (expiry = e.currentTarget.value as ExpiryChoice)}>
          {#each expiryChoices as c (c.id)}<option value={c.id}>{c.label}</option>{/each}
        </select>
        <p class="hint">A token that expires is safer if it leaks.</p>
      </div>
    </div>

    <fieldset class="limit">
      <legend>Apps</legend>
      <label class="check">
        <input type="checkbox" bind:checked={limitApps} disabled={apps === null || apps.length === 0} />
        <span>Only some apps</span>
      </label>
      {#if apps === null}
        <p class="hint">Apps could not be loaded, so the token will work for all of them.</p>
      {:else if apps.length === 0}
        <p class="hint">There are no apps yet. The token works for every app, including later ones.</p>
      {:else if !limitApps}
        <p class="hint">The token works for every app, including ones added later.</p>
      {:else}
        <div class="choices" role="group" aria-label="Apps the token may use">
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
        {#if showProblems && needsApps}<p class="field-error" role="alert">Choose at least one app, or untick “Only some apps”.</p>{/if}
        <p class="hint">An app-limited token cannot use endpoints that are not about one app, such as the repository list.</p>
      {/if}
    </fieldset>

    <fieldset class="limit">
      <legend>Actions</legend>
      <label class="check">
        <input type="checkbox" bind:checked={limitActions} />
        <span>Only some actions</span>
      </label>
      {#if !limitActions}
        <p class="hint">The token can do everything the role ceiling allows.</p>
      {:else}
        <div class="choices" role="group" aria-label="Actions the token may do">
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
          <p class="field-error" role="alert">{problems.actions ?? 'Choose at least one action, or untick “Only some actions”.'}</p>
        {/if}
      {/if}
    </fieldset>

    {#if error}<Alert tone="error">{error}</Alert>{/if}

    <div class="row actions">
      <Button type="submit" variant="primary" loading={busy}>{busy ? 'Creating…' : 'Create token'}</Button>
      <Button onclick={oncancel} disabled={busy}>Cancel</Button>
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
