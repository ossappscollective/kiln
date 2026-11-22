<!--
  ExpoProjectField: the Expo (EAS) project of ONE app record (docs/adr/0033-eas-integration.md). Pick the Expo credential, enter the
  project (its id, as in app.json under extra.eas.projectId, or @account/slug) or read it from app.json of the repository, and save. Saving
  asks Expo, with that credential, whether the project exists and the token can see it; nothing in Expo is changed, here or by removing
  the link. Everyone with `apps.read` sees the link; changing it needs `apps.write` (owners and admins).
  Props: api, workspaceId, role, app (id, platform, repositoryId), link (the saved link or null), siblings (the links of the other
  records of the same app: an iOS and an Android record usually share one project), credentials (every credential of the workspace, or
  null when the person may not read them), onchanged (called with the new link, or null after removing it).
  Readable pass (docs/design/readability.md): 15px text, label + control + ONE hint, one primary (Save).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import {
    detectedProject,
    detectionText,
    easErrorText,
    type ExpoDetection,
    type ExpoLinkView,
    expoCredentials,
    expoLinks,
    formStart,
    linkStatus,
    projectReferenceProblem,
  } from '../../lib/eas/eas.ts';
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
    siblings,
    credentials,
    now,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: { id: string; platform: string; repositoryId: string | null };
    link: ExpoLinkView | null;
    siblings: (ExpoLinkView | null)[];
    credentials: CredentialSummary[] | null;
    now: number;
    onchanged: (link: ExpoLinkView | null) => void;
  } = $props();

  const uid = $props.id();
  const canWrite = $derived(can(role, 'apps.write'));
  const choices = $derived(expoCredentials(credentials));

  let credentialId = $state('');
  let project = $state('');
  let fromSibling = $state(false);
  let problem = $state('');
  let saving = $state(false);
  let removing = $state(false);
  let detecting = $state(false);
  let detection = $state<ExpoDetection | null>(null);

  // The form starts again from the saved link (or from a sibling) whenever the record or its saved link changes.
  const startKey = $derived(`${app.id}|${link?.updatedAt ?? '-'}|${link?.credentialId ?? '-'}`);
  $effect(() => {
    void startKey;
    untrack(() => {
      const start = formStart(link, siblings);
      credentialId = start.credentialId;
      project = start.project;
      fromSibling = start.fromSibling;
      problem = '';
      detection = null;
    });
  });

  // Exactly one Expo credential: choose it for the person.
  $effect(() => {
    if (credentialId === '' && choices.length === 1 && choices[0]) credentialId = choices[0].id;
  });

  const typed = $derived(project.trim());
  const reference = $derived(projectReferenceProblem(typed));
  const dirty = $derived(
    link === null
      ? typed !== ''
      : credentialId !== link.credentialId || typed !== link.fullName || !link.credentialAvailable,
  );
  const canSave = $derived(canWrite && credentialId !== '' && reference === '' && dirty && !saving);
  const status = $derived(link ? linkStatus(link, now) : null);

  async function save() {
    if (!canSave) return;
    saving = true;
    problem = '';
    try {
      const out = await api.setExpoLink(workspaceId, app.id, { credentialId, project: typed });
      onchanged(out.link);
      toast.success(t('eas:field.linked', { project: out.link.fullName }));
    } catch (e) {
      problem = easErrorText(e);
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!canWrite || removing) return;
    removing = true;
    problem = '';
    try {
      await api.removeExpoLink(workspaceId, app.id);
      onchanged(null);
      toast.success(t('eas:field.removed'));
    } catch (e) {
      problem = easErrorText(e);
    } finally {
      removing = false;
    }
  }

  async function detect() {
    if (!canWrite || detecting) return;
    detecting = true;
    problem = '';
    detection = null;
    try {
      const out = await api.detectExpoProject(workspaceId, app.id);
      detection = out.detection;
      const found = detectedProject(out.detection);
      if (found !== '') {
        project = found;
        fromSibling = false;
      }
    } catch (e) {
      problem = easErrorText(e);
    } finally {
      detecting = false;
    }
  }
</script>

<div class="stack readable-card">
  {#if link}
    <dl class="facts">
      <div>
        <dt>{t('eas:field.project')}</dt>
        <dd>{link.projectName} <span class="muted">({link.fullName})</span></dd>
      </div>
      <div>
        <dt>{t('eas:field.projectId')}</dt>
        <dd><code>{link.projectId}</code></dd>
      </div>
      <div>
        <dt>{t('eas:field.credential')}</dt>
        <dd>{link.credentialLabel ?? t('eas:field.credentialDeleted')}</dd>
      </div>
    </dl>
    {#if status}<p class="row"><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check' : 'alert'}>{status.tone === 'ok' ? t('eas:field.badgeLinked') : t('eas:field.badgeNeedsCredential')}</Badge> <span class="muted">{status.text}</span></p>{/if}
  {:else}
    <p class="muted">{t('eas:field.notLinked')}</p>
  {/if}

  {#if canWrite}
    {#if choices.length === 0}
      <Alert tone="info">
        <T key="eas:link.credentialsHint" tags={{ link: credentialsLink }} />
      </Alert>
    {:else}
      {#if fromSibling}<p class="muted">{t('eas:field.fromSibling')}</p>{/if}
      <div class="field">
        <label for="{uid}-credential">{t('eas:field.expoCredential')}</label>
        <select id="{uid}-credential" bind:value={credentialId} disabled={saving}>
          <option value="">{t('eas:field.chooseCredential')}</option>
          {#each choices as c (c.id)}
            <option value={c.id}>{c.label}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="{uid}-project">{t('eas:field.project')}</label>
        <input
          id="{uid}-project"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder={t('eas:field.projectPlaceholder')}
          bind:value={project}
          disabled={saving}
          aria-invalid={typed !== '' && reference !== '' ? 'true' : undefined}
        />
        <p class="hint">
          {typed !== '' && reference !== '' ? reference : t('eas:field.projectHint')}
        </p>
      </div>
      {#if detection}<Alert tone={detection.detected ? 'ok' : 'info'}>{detectionText(detection)}</Alert>{/if}
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      <div class="row">
        <Button variant="primary" loading={saving} disabled={!canSave} onclick={() => void save()}>{link ? t('eas:field.saveChanges') : t('eas:field.linkProject')}</Button>
        {#if app.repositoryId}
          <Button size="sm" variant="ghost" icon="search" loading={detecting} disabled={detecting || saving} onclick={() => void detect()}>{t('eas:field.readFromRepository')}</Button>
        {/if}
        {#if link}
          <Button size="sm" variant="ghost" icon="trash" loading={removing} disabled={removing || saving} onclick={() => void remove()}>{t('eas:field.removeLink')}</Button>
        {/if}
      </div>
    {/if}
  {:else if link === null}
    <p class="muted">{t('eas:field.askAdmin')}</p>
  {/if}
</div>

{#snippet credentialsLink(text: string)}<a href={expoLinks.credentials}>{text}</a>{/snippet}

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
