<!--
  RevenueCatLinkField: the RevenueCat project and app of ONE app record (docs/adr/0039-revenuecat.md). Pick the RevenueCat credential,
  look up what it sees (its projects, and for one project its apps), choose the RevenueCat app and save. Saving asks RevenueCat, with that
  credential, whether the project and the app exist; nothing in RevenueCat is changed, here or by removing the link. Only apps of the
  stores this tool reads (App Store, Mac App Store, Google Play) can be linked; the others are listed with a note and ignored.
  Everyone with `apps.read` sees the link; changing it needs `apps.write` (owners and admins).
  Props: api, workspaceId, role, app (id, platform, name), link (the saved link or null), credentials (every credential of the workspace,
  or null when the person may not read them), now, onchanged (called with the new link, or null after removing it).
  Readable pass (docs/design/readability.md): 15px text, label + control + ONE hint, one primary (Save).
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    appChoiceLabel,
    appsNote,
    appTypeLabel,
    identifierNote,
    linkStatus,
    type RevenueCatLinkView,
    type RevenueCatOptions,
    revenueCatCredentials,
    revenueCatErrorText,
    revenueCatLinks,
    startingChoice,
  } from '../../lib/revenuecat/revenuecat.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import '../readable-card.css';

  let {
    api,
    workspaceId,
    role,
    app,
    link,
    credentials,
    now,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: string; name: string };
    link: RevenueCatLinkView | null;
    credentials: CredentialSummary[] | null;
    now: number;
    onchanged: (link: RevenueCatLinkView | null) => void;
  } = $props();

  const uid = $props.id();
  const canWrite = $derived(can(role, 'apps.write'));
  const choices = $derived(revenueCatCredentials(credentials));

  let credentialId = $state('');
  let projectId = $state('');
  let appId = $state('');
  let options = $state<RevenueCatOptions | null>(null);
  let problem = $state('');
  let looking = $state(false);
  let saving = $state(false);
  let removing = $state(false);

  // The form starts again from the saved link whenever the record or its saved link changes.
  const startKey = $derived(`${app.id}|${link?.updatedAt ?? '-'}|${link?.credentialId ?? '-'}`);
  $effect(() => {
    void startKey;
    untrack(() => {
      credentialId = link && link.credentialAvailable ? link.credentialId : '';
      projectId = link ? link.projectId : '';
      appId = link ? link.revenueCatAppId : '';
      options = null;
      problem = '';
    });
  });

  // Exactly one RevenueCat credential: choose it for the person.
  $effect(() => {
    if (credentialId === '' && choices.length === 1 && choices[0]) credentialId = choices[0].id;
  });

  const picked = $derived(options?.apps?.filter((a) => a.id === appId)[0] ?? null);
  const dirty = $derived(
    link === null ||
      !link.credentialAvailable ||
      credentialId !== link.credentialId ||
      projectId !== link.projectId ||
      appId !== link.revenueCatAppId,
  );
  const canSave = $derived(canWrite && credentialId !== '' && projectId !== '' && picked !== null && picked.linkable && dirty && !saving && !looking);
  const status = $derived(link ? linkStatus(link, now) : null);
  const note = $derived(link ? identifierNote(link) : '');

  async function lookUp(forProject?: string) {
    if (!canWrite || credentialId === '' || looking) return;
    looking = true;
    problem = '';
    try {
      const out = await api.detectRevenueCat(workspaceId, app.id, credentialId, forProject);
      options = out.options;
      projectId = out.options.projectId ?? '';
      appId = startingChoice(out.options.apps);
    } catch (e) {
      problem = revenueCatErrorText(e);
    } finally {
      looking = false;
    }
  }

  async function save() {
    if (!canSave) return;
    saving = true;
    problem = '';
    try {
      const out = await api.setRevenueCatLink(workspaceId, app.id, { credentialId, projectId, revenueCatAppId: appId });
      onchanged(out.link);
      toast.success(`Linked to ${out.link.projectName}. Nothing in RevenueCat was changed. Use "Sync products" to read it.`);
    } catch (e) {
      problem = revenueCatErrorText(e);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!canWrite || removing) return;
    removing = true;
    problem = '';
    try {
      await api.removeRevenueCatLink(workspaceId, app.id);
      onchanged(null);
      toast.success('Removed the link and what was read from RevenueCat. Nothing in RevenueCat was changed.');
    } catch (e) {
      problem = revenueCatErrorText(e);
    } finally {
      removing = false;
    }
  }
</script>

<div class="stack readable-card">
  {#if link}
    <dl class="facts">
      <div>
        <dt>Project</dt>
        <dd>{link.projectName}</dd>
      </div>
      <div>
        <dt>RevenueCat app</dt>
        <dd>{link.revenueCatAppName} <span class="muted">({appTypeLabel(link.revenueCatAppType)}{link.revenueCatIdentifier ? `, ${link.revenueCatIdentifier}` : ''})</span></dd>
      </div>
      <div>
        <dt>Credential</dt>
        <dd>{link.credentialLabel ?? 'Deleted'}</dd>
      </div>
    </dl>
    {#if status}<p class="row"><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check' : 'alert'}>{status.tone === 'ok' ? 'Linked' : 'Needs a credential'}</Badge> <span class="muted">{status.text}</span></p>{/if}
    {#if note}<p class="muted">{note}</p>{/if}
  {:else}
    <p class="muted">This app is not linked to a RevenueCat project. Linking shows, in the Products table, which products RevenueCat sells and the entitlements and offerings that use them.</p>
  {/if}

  {#if canWrite}
    {#if choices.length === 0}
      <Alert tone="info">
        Add a RevenueCat secret key first. In <a href={revenueCatLinks.credentials}>Credentials</a>, choose “RevenueCat secret key”; the guide there explains how to create a read-only key.
      </Alert>
    {:else}
      <div class="field">
        <label for="{uid}-credential">RevenueCat credential</label>
        <select id="{uid}-credential" bind:value={credentialId} disabled={saving || looking} onchange={() => (options = null)}>
          <option value="">Choose a credential</option>
          {#each choices as c (c.id)}
            <option value={c.id}>{c.label}</option>
          {/each}
        </select>
      </div>
      <div class="row">
        <Button size="sm" icon="search" loading={looking} disabled={credentialId === '' || looking || saving} onclick={() => void lookUp()}>
          {options ? 'Look up again' : 'Look up projects and apps'}
        </Button>
        <span class="muted">RevenueCat is asked with this credential; nothing is saved yet.</span>
      </div>
      {#if options}
        {#if options.projects.length === 0}
          <Alert tone="info">This key sees no RevenueCat project. Check that the key belongs to the project of this app.</Alert>
        {:else if options.projects.length > 1}
          <div class="field">
            <label for="{uid}-project">RevenueCat project</label>
            <select id="{uid}-project" bind:value={projectId} disabled={saving || looking} onchange={() => void lookUp(projectId)}>
              <option value="">Choose a project</option>
              {#each options.projects as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
            <p class="hint">A V2 secret key belongs to one project; this one sees several.</p>
          </div>
        {/if}
        {#if options.apps !== null}
          {#if options.apps.length > 0}
            <div class="field">
              <label for="{uid}-app">RevenueCat app</label>
              <select id="{uid}-app" bind:value={appId} disabled={saving || looking}>
                <option value="">Choose an app</option>
                {#each options.apps as a (a.id)}
                  <option value={a.id} disabled={!a.linkable}>{appChoiceLabel(a)}</option>
                {/each}
              </select>
              {#if picked && picked.note}
                <p class="hint">{picked.note}</p>
              {:else if picked && picked.identifier !== null && !picked.matches}
                <p class="hint">RevenueCat holds {picked.identifier} for this app, which differs from the identifier of this app. You can still link it (a universal purchase may differ).</p>
              {:else}
                <p class="hint">The app whose bundle id or package name is this app's is suggested.</p>
              {/if}
            </div>
          {/if}
          {#if appsNote(options.apps) !== ''}<p class="muted">{appsNote(options.apps)}</p>{/if}
          {#if !options.complete}<p class="muted">RevenueCat has more apps than were listed; if yours is missing, link it by choosing another project.</p>{/if}
        {/if}
      {/if}
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={saving} disabled={!canSave} onclick={() => void save()}>{link ? 'Save changes' : 'Link project'}</Button>
        {#if link}
          <Button size="sm" variant="ghost" icon="trash" loading={removing} disabled={removing || saving} onclick={() => void remove()}>Remove the link</Button>
        {/if}
      </div>
    {/if}
  {:else if link === null}
    <p class="muted">Ask an owner or an admin to link it.</p>
  {/if}
</div>

<style>
  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-3) var(--space-6);
    margin: 0;
  }

  .facts dt {
    margin: 0 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .facts dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
