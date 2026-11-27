<!--
  ConnectAppsDialog: "Connect your apps" (docs/ux-ia.md, docs/adr/0039-revenuecat.md, docs/adr/0033-eas-integration.md). Lists the app records
  that have no RevenueCat (or Expo) link with the proposed match and a checkbox each; NOTHING is written until the person confirms, and
  confirming saves Kiln's own link per record (the existing PUT routes). RevenueCat and Expo are only read, never changed. A record with
  several possible matches is never picked for the person: it shows a select. After linking it says where the data appears (Products, Builds)
  and what is still empty and why, and offers the first read.
  Props: api, workspaceId, role, apps (the records in scope), kind, only (the record ids to limit to, or null for every record),
  open (bindable).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { type Api } from '../../lib/api.ts';
  import {
    afterLinking,
    type ConnectKind,
    type ConnectRow,
    canLink,
    counts,
    credentialsFor,
    decodeChoice,
    destinationHref,
    expoRows,
    type IntegrationLinks,
    type LinkOutcome,
    rcRows,
    repositoriesToDetect,
    toLink,
    withChecked,
    withValue,
  } from '../../lib/connect/connect.ts';
  import { connectStore } from '../../lib/app-state/connect-facade.ts';
  import { type ExpoDetection, easErrorText, projectReferenceProblem } from '../../lib/eas/eas.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { runLimited } from '../../lib/portfolio.ts';
  import { revenueCatErrorText, stepFromBody, stepResult } from '../../lib/revenuecat/revenuecat.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import Spinner from '../ui/Spinner.svelte';

  let {
    api,
    workspaceId,
    role,
    apps,
    kind,
    only = null,
    open = $bindable(false),
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    apps: AppSummary[];
    kind: ConnectKind;
    only?: string[] | null;
    open?: boolean;
  } = $props();

  type Step = 'loading' | 'credential' | 'review' | 'saving' | 'done';

  const uid = $props.id();
  const mayWrite = $derived(can(role, 'apps.write'));
  const maySync = $derived(can(role, 'apps.sync'));
  const scope = $derived(apps.filter((a) => only === null || only.indexOf(a.id) >= 0));

  let step = $state<Step>('loading');
  let keys = $state<CredentialSummary[]>([]);
  let credentialId = $state('');
  let rows = $state<ConnectRow[]>([]);
  let problem = $state('');
  let outcomes = $state<LinkOutcome[]>([]);
  let reading = $state<Record<string, { text: string; tone: 'ok' | 'warn' | 'bad' }>>({});
  let readingNow = $state(false);
  let generation = 0;

  const label = $derived(kind === 'revenuecat' ? t('connect:rc.name') : t('connect:expo.name'));
  const chosen = $derived(toLink(kind, rows));
  const waiting = $derived(counts(rows));
  const done = $derived(outcomes.filter((o) => o.ok));
  const failed = $derived(outcomes.filter((o) => !o.ok));
  const after = $derived(afterLinking(kind));

  $effect(() => {
    if (!open) return;
    void workspaceId;
    void kind;
    untrack(() => void start());
  });

  const problemText = (e: unknown) => (kind === 'revenuecat' ? revenueCatErrorText(e) : easErrorText(e));

  async function start() {
    const mine = ++generation;
    step = 'loading';
    problem = '';
    rows = [];
    outcomes = [];
    reading = {};
    try {
      const list = can(role, 'credentials.read') ? (await api.credentials(workspaceId)).credentials : [];
      if (mine !== generation) return;
      keys = credentialsFor(kind, list);
    } catch (e) {
      if (mine !== generation) return;
      keys = [];
      problem = problemText(e);
    }
    credentialId = keys[0]?.id ?? '';
    if (keys.length === 1) await review();
    else if (mine === generation) step = 'credential';
  }

  async function review() {
    if (credentialId === '') return;
    const mine = ++generation;
    step = 'loading';
    problem = '';
    try {
      const links: IntegrationLinks = await api.integrationLinks(workspaceId);
      let next: ConnectRow[];
      if (kind === 'revenuecat') {
        next = rcRows((await api.planRevenueCat(workspaceId, credentialId)).plan, only);
      } else {
        const detections: Record<string, ExpoDetection | null> = {};
        await runLimited(repositoriesToDetect(scope, links), 3, async (r) => {
          try {
            detections[r.repositoryId] = (await api.detectExpoProject(workspaceId, r.appId)).detection;
          } catch {
            detections[r.repositoryId] = null;
          }
        });
        next = expoRows(scope, links, detections);
      }
      if (mine !== generation) return;
      rows = next;
      step = 'review';
    } catch (e) {
      if (mine !== generation) return;
      problem = problemText(e);
      step = 'credential';
    }
  }

  const setRow = (id: string, make: (r: ConnectRow) => ConnectRow) => {
    rows = rows.map((r) => (r.appId === id ? make(r) : r));
  };

  async function confirm() {
    if (chosen.length === 0 || !mayWrite) return;
    step = 'saving';
    const result: LinkOutcome[] = [];
    await runLimited(chosen, 2, async (row) => {
      const at = chosen.indexOf(row);
      try {
        if (kind === 'revenuecat') {
          const pick = decodeChoice(row.value);
          if (pick === null) throw new Error('no choice');
          await api.setRevenueCatLink(workspaceId, row.appId, { credentialId, ...pick });
        } else {
          await api.setExpoLink(workspaceId, row.appId, { credentialId, project: row.value.trim() });
        }
        result[at] = { appId: row.appId, name: row.name, ok: true, problem: '' };
      } catch (e) {
        result[at] = { appId: row.appId, name: row.name, ok: false, problem: problemText(e) };
      }
    });
    outcomes = result;
    connectStore.bump();
    step = 'done';
  }

  /** The first read after linking: "Sync products" (RevenueCat) or Expo's builds. Reads only; the same calls as the Products and Builds pages. */
  async function readNow() {
    if (!maySync || readingNow) return;
    readingNow = true;
    await runLimited(done, 2, async (o) => {
      try {
        if (kind === 'revenuecat') {
          const out = await api.syncAppProducts(workspaceId, o.appId);
          reading = { ...reading, [o.appId]: out.revenuecat ? stepResult(out.revenuecat) : { text: t('connect:done.read.ok'), tone: 'ok' } };
        } else {
          await api.refreshEasStatus(workspaceId, o.appId);
          reading = { ...reading, [o.appId]: { text: t('connect:done.read.ok'), tone: 'ok' } };
        }
      } catch (e) {
        const step = e instanceof Object && 'body' in e ? stepFromBody((e as { body: Record<string, unknown> }).body) : null;
        reading = { ...reading, [o.appId]: step ? stepResult(step) : { text: problemText(e), tone: 'bad' } };
      }
    });
    readingNow = false;
  }

  const status = (r: ConnectRow): string => {
    if (r.status === 'linked') return t('connect:row.linked');
    if (kind === 'revenuecat') {
      if (r.status === 'proposed') return t('connect:row.rc.proposed');
      if (r.status === 'ambiguous') return t('connect:row.rc.ambiguous');
      return r.choices.length > 0 ? t('connect:row.rc.none') : t('connect:row.rc.nothing');
    }
    return r.status === 'proposed' ? t('connect:row.expo.proposed') : t('connect:row.expo.none');
  };
</script>

<Modal
  bind:open
  size="lg"
  title={t('connect:dialog.title', { name: label })}
  description={step === 'done' ? undefined : t('connect:dialog.description', { name: label })}
  dismissible={step !== 'saving'}
>
  <div class="stack" data-testid="connect-dialog">
    {#if !mayWrite}
      <Alert tone="info">{t('connect:dialog.askAdmin')}</Alert>
    {:else if step === 'loading' || step === 'saving'}
      <p class="row muted" role="status"><Spinner />{step === 'saving' ? t('connect:dialog.saving') : kind === 'revenuecat' ? t('connect:dialog.readingRc') : t('connect:dialog.readingExpo')}</p>
    {:else if step === 'credential'}
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {#if keys.length === 0}
        <Alert tone="info">
          {kind === 'revenuecat' ? t('connect:dialog.noKey.rc') : t('connect:dialog.noKey.expo')}
          <a href="#/credentials">{t('connect:dialog.addKey')}</a>
        </Alert>
      {:else}
        <div class="field">
          <label for="{uid}-key">{kind === 'revenuecat' ? t('connect:dialog.keyLabel.rc') : t('connect:dialog.keyLabel.expo')}</label>
          <select id="{uid}-key" bind:value={credentialId}>
            {#each keys as k (k.id)}<option value={k.id}>{k.label}</option>{/each}
          </select>
          <p class="hint">{t('connect:dialog.keyHint')}</p>
        </div>
      {/if}
    {:else if step === 'review'}
      {#if rows.length === 0 || (waiting.proposed + waiting.ambiguous + waiting.none === 0)}
        <Alert tone="ok">{t('connect:dialog.nothingToDo', { name: label })}</Alert>
      {:else}
        <p class="muted">{kind === 'revenuecat' ? t('connect:dialog.reviewRc') : t('connect:dialog.reviewExpo')}</p>
        {#if kind === 'expo'}<p class="muted">{t('connect:dialog.expoHelp')}</p>{/if}
        <ul class="rows">
          {#each rows as r (r.appId)}
            <li class="item" class:dim={r.status === 'linked'}>
              <input
                type="checkbox"
                id="{uid}-c-{r.appId}"
                checked={r.checked && canLink(kind, r)}
                disabled={r.status === 'linked' || !canLink(kind, r)}
                onchange={(e) => setRow(r.appId, (x) => withChecked(x, e.currentTarget.checked))}
                aria-label={t('connect:row.checkAria', { name: r.name })}
              />
              <div class="what">
                <label for="{uid}-c-{r.appId}" class="name"><PlatformBadge platform={r.platform} /> {r.name} <span class="muted">{r.identifier}</span></label>
                <span class="muted text-sm">{status(r)}</span>
              </div>
              {#if r.status !== 'linked'}
                {#if kind === 'revenuecat'}
                  {#if r.choices.length > 0}
                    <select
                      aria-label={t('connect:row.rc.selectAria', { name: r.name })}
                      value={r.value}
                      onchange={(e) => setRow(r.appId, (x) => withValue(kind, x, e.currentTarget.value))}
                    >
                      <option value="">{t('connect:row.rc.choose')}</option>
                      {#each r.choices as c (c.value)}<option value={c.value}>{c.label}</option>{/each}
                    </select>
                  {/if}
                {:else}
                  <input
                    type="text"
                    class="project"
                    autocomplete="off"
                    spellcheck="false"
                    aria-label={t('connect:row.expo.inputAria', { name: r.name })}
                    aria-invalid={r.value.trim() !== '' && projectReferenceProblem(r.value.trim()) !== '' ? 'true' : undefined}
                    placeholder={t('connect:row.expo.placeholder')}
                    value={r.value}
                    oninput={(e) => setRow(r.appId, (x) => withValue(kind, x, e.currentTarget.value))}
                  />
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        <p class="muted text-sm">{kind === 'revenuecat' ? t('connect:dialog.safeRc') : t('connect:dialog.safeExpo')}</p>
      {/if}
    {:else}
      <Alert tone={failed.length === 0 ? 'ok' : 'warn'} title={t('connect:done.title', { count: done.length, name: label })}>
        {#if done.length > 0}
          <p>{after.appears}</p>
          <p>{after.empty}</p>
        {/if}
      </Alert>
      <ul class="rows">
        {#each outcomes as o (o.appId)}
          <li class="item">
            <div class="what">
              <span class="name">{o.name}</span>
              {#if o.ok}
                <span class="muted text-sm">{reading[o.appId]?.text ?? t('connect:done.linkedRow')}</span>
              {:else}
                <span class="bad text-sm">{t('connect:done.failedRow', { problem: o.problem })}</span>
              {/if}
            </div>
            {#if o.ok}
              <a href={destinationHref(kind, o.appId)} onclick={() => (open = false)}>{kind === 'revenuecat' ? t('connect:done.openProducts') : t('connect:done.openBuilds')}</a>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  {#snippet footer()}
    {#if step === 'done'}
      {#if done.length > 0 && maySync}
        <Button icon="refresh" loading={readingNow} disabled={readingNow} onclick={() => void readNow()}>{kind === 'revenuecat' ? t('connect:done.syncProducts') : t('connect:done.readExpo')}</Button>
      {/if}
      {#if done[0]}
        <Button variant="primary" href={destinationHref(kind, done[0].appId)} onclick={() => (open = false)}>{kind === 'revenuecat' ? t('connect:done.openProducts') : t('connect:done.openBuilds')}</Button>
      {:else}
        <Button variant="primary" onclick={() => (open = false)}>{t('common:action.close')}</Button>
      {/if}
    {:else}
      <Button variant="ghost" disabled={step === 'saving'} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
      {#if step === 'credential' && keys.length > 0}
        <Button variant="primary" disabled={credentialId === ''} onclick={() => void review()}>{t('connect:dialog.lookUp')}</Button>
      {:else if step === 'review' && mayWrite}
        <Button variant="primary" disabled={chosen.length === 0} onclick={() => void confirm()}>{t('connect:dialog.confirm', { count: chosen.length })}</Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  .rows {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--border);
  }

  .item.dim {
    opacity: 0.7;
  }

  .what {
    display: flex;
    flex: 1 1 14rem;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }

  .name {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    overflow-wrap: anywhere;
  }

  .item select,
  .project {
    flex: 1 1 16rem;
    min-width: 0;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .bad {
    color: var(--bad-ink);
  }
</style>
