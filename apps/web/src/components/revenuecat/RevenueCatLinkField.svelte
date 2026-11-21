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
  import { type Role, can } from '@kiln/core';
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
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import T from '../ui/T.svelte';
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
      toast.success(t('products:rc.link.linked', { project: out.link.projectName }));
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
      toast.success(t('products:rc.link.removed'));
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
        <dt>{t('products:rc.link.project')}</dt>
        <dd>{link.projectName}</dd>
      </div>
      <div>
        <dt>{t('products:rc.link.app')}</dt>
        <dd>{link.revenueCatAppName} <span class="muted">({appTypeLabel(link.revenueCatAppType)}{link.revenueCatIdentifier ? `, ${link.revenueCatIdentifier}` : ''})</span></dd>
      </div>
      <div>
        <dt>{t('products:rc.link.credential')}</dt>
        <dd>{link.credentialLabel ?? t('products:rc.link.deleted')}</dd>
      </div>
    </dl>
    {#if status}<p class="row"><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check' : 'alert'}>{status.tone === 'ok' ? t('products:rc.link.badgeLinked') : t('products:rc.link.badgeNeedsCredential')}</Badge> <span class="muted">{status.text}</span></p>{/if}
    {#if note}<p class="muted">{note}</p>{/if}
  {:else}
    <p class="muted">{t('products:rc.link.notLinked')}</p>
  {/if}

  {#if canWrite}
    {#if choices.length === 0}
      <Alert tone="info">
        <T key="products:rc.link.addKey" tags={{ link: credentialsLink }} />
      </Alert>
    {:else}
      <div class="field">
        <label for="{uid}-credential">{t('products:rc.link.credentialLabel')}</label>
        <select id="{uid}-credential" bind:value={credentialId} disabled={saving || looking} onchange={() => (options = null)}>
          <option value="">{t('products:rc.link.chooseCredential')}</option>
          {#each choices as c (c.id)}
            <option value={c.id}>{c.label}</option>
          {/each}
        </select>
      </div>
      <div class="row">
        <Button size="sm" icon="search" loading={looking} disabled={credentialId === '' || looking || saving} onclick={() => void lookUp()}>
          {options ? t('products:rc.link.lookUpAgain') : t('products:rc.link.lookUp')}
        </Button>
        <span class="muted">{t('products:rc.link.lookUpHint')}</span>
      </div>
      {#if options}
        {#if options.projects.length === 0}
          <Alert tone="info">{t('products:rc.link.noProject')}</Alert>
        {:else if options.projects.length > 1}
          <div class="field">
            <label for="{uid}-project">{t('products:rc.link.projectLabel')}</label>
            <select id="{uid}-project" bind:value={projectId} disabled={saving || looking} onchange={() => void lookUp(projectId)}>
              <option value="">{t('products:rc.link.chooseProject')}</option>
              {#each options.projects as p (p.id)}
                <option value={p.id}>{p.name}</option>
              {/each}
            </select>
            <p class="hint">{t('products:rc.link.severalProjects')}</p>
          </div>
        {/if}
        {#if options.apps !== null}
          {#if options.apps.length > 0}
            <div class="field">
              <label for="{uid}-app">{t('products:rc.link.appLabel')}</label>
              <select id="{uid}-app" bind:value={appId} disabled={saving || looking}>
                <option value="">{t('products:rc.link.chooseApp')}</option>
                {#each options.apps as a (a.id)}
                  <option value={a.id} disabled={!a.linkable}>{appChoiceLabel(a)}</option>
                {/each}
              </select>
              {#if picked && picked.note}
                <p class="hint">{picked.note}</p>
              {:else if picked && picked.identifier !== null && !picked.matches}
                <p class="hint">{t('products:rc.link.pickedDiffers', { identifier: picked.identifier })}</p>
              {:else}
                <p class="hint">{t('products:rc.link.suggestedHint')}</p>
              {/if}
            </div>
          {/if}
          {#if appsNote(options.apps) !== ''}<p class="muted">{appsNote(options.apps)}</p>{/if}
          {#if !options.complete}<p class="muted">{t('products:rc.link.moreApps')}</p>{/if}
        {/if}
      {/if}
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={saving} disabled={!canSave} onclick={() => void save()}>{link ? t('products:rc.link.save') : t('products:rc.link.linkProject')}</Button>
        {#if link}
          <Button size="sm" variant="ghost" icon="trash" loading={removing} disabled={removing || saving} onclick={() => void remove()}>{t('products:rc.link.remove')}</Button>
        {/if}
      </div>
    {/if}
  {:else if link === null}
    <p class="muted">{t('products:rc.link.askAdmin')}</p>
  {/if}
</div>

{#snippet credentialsLink(text: string)}<a href={revenueCatLinks.credentials}>{text}</a>{/snippet}

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
