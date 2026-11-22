<!--
  PlanOverview: the top of a plan: whether it is ready by our checklist and release notes, the
  target date with its due soon or overdue flag, the blocked flag with its reason, and free notes
  for the team. All of it is our own planning data; nothing is sent to a store. Without the right to
  write, it is read only.
  Props: api, workspaceId, plan (PlanDetail), canWrite, onplan (called with every updated plan),
  ondelete (called after the plan was deleted).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { formatTargetDate, planErrorMessage } from '../../lib/release.ts';
  import { planLine } from '../../lib/release-detail.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { PlanChanges, PlanDetail } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Modal from '../ui/Modal.svelte';
  import T from '../ui/T.svelte';

  let {
    api,
    workspaceId,
    plan,
    canWrite,
    onplan,
    ondelete,
  }: {
    api: Api;
    workspaceId: string;
    plan: PlanDetail;
    canWrite: boolean;
    onplan: (plan: PlanDetail) => void;
    ondelete: () => void;
  } = $props();

  const uid = $props.id();

  let busy = $state(false);
  let problem = $state('');
  let editingBlock = $state(false);
  let reasonDraft = $state('');
  let reasonProblem = $state('');
  let notesDraft = $state<string | undefined>(undefined);
  let confirmDelete = $state(false);
  let deleteProblem = $state('');

  const notes = $derived(notesDraft ?? plan.notes);
  const notesDirty = $derived(notesDraft !== undefined && notesDraft !== plan.notes);
  const readiness = $derived(plan.readiness);

  async function change(changes: PlanChanges): Promise<boolean> {
    if (busy) return false;
    busy = true;
    problem = '';
    try {
      onplan((await api.updatePlan(workspaceId, plan.appId, plan.id, changes)).plan);
      return true;
    } catch (e) {
      problem = planErrorMessage(e);
      return false;
    } finally {
      busy = false;
    }
  }

  async function setDate(input: HTMLInputElement) {
    const value = input.value === '' ? null : input.value;
    if (value === plan.targetDate) return;
    if (!(await change({ targetDate: value }))) input.value = plan.targetDate ?? '';
  }

  function startBlock() {
    reasonDraft = plan.blockedReason ?? '';
    reasonProblem = '';
    editingBlock = true;
  }

  async function saveBlock(event: SubmitEvent) {
    event.preventDefault();
    const reason = reasonDraft.trim();
    if (!reason) {
      reasonProblem = t('release:plan.reasonRequired');
      return;
    }
    if (await change({ blocked: true, blockedReason: reason })) {
      editingBlock = false;
      toast.success(t('release:plan.toast.blocked'));
    }
  }

  async function unblock() {
    if (await change({ blocked: false })) toast.success(t('release:plan.toast.unblocked'));
  }

  async function saveNotes() {
    if (notesDraft === undefined) return;
    if (await change({ notes: notesDraft })) notesDraft = undefined;
  }

  async function removePlan() {
    busy = true;
    deleteProblem = '';
    try {
      await api.deletePlan(workspaceId, plan.appId, plan.id);
      confirmDelete = false;
      toast.success(t('release:plan.toast.deleted', { version: plan.version }));
      ondelete();
    } catch (e) {
      deleteProblem = planErrorMessage(e);
    } finally {
      busy = false;
    }
  }
</script>

<section class="card" aria-labelledby="{uid}-title">
  <div class="card-header">
    <div>
      <h2 id="{uid}-title">{t('release:plan.title')}</h2>
      <p data-testid="plan-line">{planLine(plan)}</p>
    </div>
    <div class="row">
      {#if plan.blocked}<Badge tone="bad" icon={toneIcon('bad')}>{t('release:plan.blocked')}</Badge>{/if}
      <Badge tone={readiness.ready ? 'ok' : 'warn'} icon={toneIcon(readiness.ready ? 'ok' : 'warn')}>{readiness.ready ? t('release:plan.ready') : t('release:plan.notReady')}</Badge>
    </div>
  </div>

  {#if problem}<Alert tone="error">{problem}</Alert>{/if}

  <div class="stack loose">
    <div class="readiness">
      {#if readiness.reasons.length > 0}
        <p class="line"><strong>{t('release:plan.standsInTheWay')}</strong></p>
        <ul class="reasons">
          {#each readiness.reasons as reason (reason)}<li>{reason}</li>{/each}
        </ul>
      {:else}
        <p class="muted line">{t('release:plan.allReady')}</p>
      {/if}
    </div>

    <Disclosure summary={t('release:plan.details')} stateKey="release-plan-details" open={plan.blocked}>
    <div class="stack loose">
    <p class="muted line quiet">{t('release:plan.ownNotes')}</p>
    <div class="grid">
      <div class="field">
        <label for="{uid}-date">{t('release:plan.targetDate')}</label>
        <div class="row">
          <input id="{uid}-date" type="date" value={plan.targetDate ?? ''} disabled={!canWrite || busy} onchange={(e) => setDate(e.currentTarget)} aria-describedby="{uid}-date-hint" />
          {#if canWrite && plan.targetDate}
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => change({ targetDate: null })}>{t('release:plan.clearDate')}</Button>
          {/if}
        </div>
        <p id="{uid}-date-hint" class="hint">
          {#if plan.targetDate}
            {t('release:plan.dateHint', { date: formatTargetDate(plan.targetDate) })}
          {:else}
            {t('release:plan.dateHintNone')}
          {/if}
        </p>
      </div>
    </div>

    <div class="block">
      <h3>{t('release:plan.blockedHeading')}</h3>
      {#if editingBlock}
        <form class="stack" onsubmit={saveBlock}>
          <div class="field">
            <label for="{uid}-reason">{t('release:plan.whyBlocked')}</label>
            <textarea id="{uid}-reason" rows="3" maxlength="500" bind:value={reasonDraft} aria-invalid={reasonProblem !== ''} aria-describedby="{uid}-reason-hint"></textarea>
            {#if reasonProblem}<p class="field-error" role="alert">{reasonProblem}</p>{/if}
            <p id="{uid}-reason-hint" class="hint">{t('release:plan.whyBlockedHint')}</p>
          </div>
          <div class="row">
            <Button type="submit" variant="primary" loading={busy}>{plan.blocked ? t('release:plan.saveReason') : t('release:plan.markBlocked')}</Button>
            <Button disabled={busy} onclick={() => (editingBlock = false)}>{t('common:action.cancel')}</Button>
          </div>
        </form>
      {:else if plan.blocked}
        <p class="line"><strong>{t('release:plan.blockedLabel')}</strong> {plan.blockedReason}</p>
        {#if canWrite}
          <div class="row actions">
            <Button disabled={busy} onclick={startBlock}>{t('release:plan.changeReason')}</Button>
            <Button loading={busy} onclick={unblock}>{t('release:plan.clearBlock')}</Button>
          </div>
        {/if}
      {:else}
        <p class="muted line">{t('release:plan.notBlocked')}</p>
        {#if canWrite}
          <div class="row actions"><Button disabled={busy} icon="alert-triangle" onclick={startBlock}>{t('release:plan.markBlocked')}</Button></div>
        {/if}
      {/if}
    </div>

    {#if canWrite || plan.notes}
      <div class="field">
        <label for="{uid}-notes">{t('release:plan.teamNotes')}</label>
        <textarea id="{uid}-notes" rows="3" maxlength="4000" value={notes} readonly={!canWrite} oninput={(e) => (notesDraft = e.currentTarget.value)}></textarea>
        {#if canWrite}
          <div class="row actions">
            <Button size="sm" disabled={!notesDirty || busy} onclick={saveNotes}>{t('release:plan.saveNotes')}</Button>
          </div>
        {/if}
      </div>
    {/if}

    {#if canWrite}
      <div class="danger-zone">
        <Button variant="danger" icon="trash" disabled={busy} onclick={() => { deleteProblem = ''; confirmDelete = true; }}>{t('release:plan.deleteThis')}</Button>
      </div>
    {/if}
    </div>
    </Disclosure>
  </div>
</section>

{#if canWrite}
  <Modal bind:open={confirmDelete} size="sm" title={t('release:plan.confirm.title')} dismissible={!busy}>
    <div class="stack">
      <p>
        <T
          key="release:plan.confirm.body"
          params={{ version: plan.version, items: t('release:plan.confirm.items', { count: plan.items.length }), locales: t('release:plan.confirm.locales', { count: plan.releaseNotes.length }) }}
        />
      </p>
      <p class="muted">{t('release:plan.confirm.noStoreChange')}</p>
      {#if deleteProblem}<Alert tone="error">{deleteProblem}</Alert>{/if}
    </div>
    {#snippet footer()}
      <Button disabled={busy} onclick={() => (confirmDelete = false)}>{t('common:action.cancel')}</Button>
      <Button variant="danger-solid" loading={busy} onclick={removePlan}>{t('release:plan.confirm.delete')}</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .line {
    margin: 0;
    font-size: 1rem;
  }

  .quiet {
    margin-bottom: var(--space-4);
    font-size: 0.9375rem;
  }

  .readiness {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .reasons {
    padding-left: var(--space-5);
    margin: 0;
  }

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: var(--space-4);
  }

  .grid .field {
    margin: 0;
  }

  .block h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-base);
  }

  .actions {
    margin-top: var(--space-3);
  }

  .danger-zone {
    padding-top: var(--space-4);
    border-top: 1px solid var(--line);
  }
</style>
