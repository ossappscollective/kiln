<!--
  Rollout: the staged rollout PLAN of one release: an ordered list of steps (percent, planned time,
  status), templates (a Google Play ramp, Apple's fixed 7 day phased release shown for information,
  immediate), and what the store last reported next to it.
  It is planning data only. Nothing here starts, changes or stops a rollout in a store; marking a
  step done only records it here. A step is never marked done by itself: when the store's share has
  reached a step, "Confirm from the store" is offered and a person has to click it.
  Props: api, workspaceId, plan (PlanDetail), canWrite, onsummary (called with the short summary
  after every change, so the plan header can show it).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { byFamily, checkRolloutAction, formatPercent, MAX_ROLLOUT_STEPS, platformMeta, type RolloutSummary, type RolloutTemplate, rolloutTemplatesFor } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    type DraftStep,
    addDraftStep,
    barWidth,
    comparisonLabel,
    comparisonTone,
    draftFromSteps,
    draftToBody,
    formatPlannedAt,
    formatTargetDate,
    localInputValue,
    parseLocalInput,
    planErrorMessage,
    rolloutHeadline,
    stepChip,
  } from '../../lib/release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { PlanDetail, RolloutStep, RolloutView } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let {
    api,
    workspaceId,
    plan,
    canWrite,
    onsummary,
  }: {
    api: Api;
    workspaceId: string;
    plan: PlanDetail;
    canWrite: boolean;
    onsummary: (summary: RolloutSummary | null) => void;
  } = $props();

  const uid = $props.id();

  let view = $state<RolloutView | null>(null);
  let loading = $state(true);
  let loadProblem = $state('');
  let busy = $state(false);
  let problem = $state('');
  let announcement = $state('');
  let now = $state(Date.now());
  let editing = $state(false);
  let draft = $state<DraftStep[]>([]);
  let rowProblems = $state<Record<string, string>>({});
  let generalProblems = $state<string[]>([]);
  let templateId = $state('');
  let startDraft = $state('');
  let startProblem = $state('');
  let confirmClear = $state(false);

  const templates = $derived<RolloutTemplate[]>(rolloutTemplatesFor(plan.appPlatform));
  const chosen = $derived(templates.find((t) => t.id === templateId) ?? templates[0]);
  const steps = $derived(view?.steps ?? []);
  const comparison = $derived(view?.comparison ?? null);
  const store = $derived(view?.store ?? null);
  const storeSource = $derived(store ? byFamily(store.platform, { apple: 'App Store Connect', google: 'Google Play' }) : 'App Store Connect');
  const hasDone = $derived(steps.some((s) => s.status === 'done'));

  let generation = 0;

  // Reload only when it is another plan: the plan object itself is replaced after every change to
  // the checklist or the notes, which must not make this card flash and read again.
  const planKey = $derived(`${workspaceId}/${plan.appId}/${plan.id}`);

  $effect(() => {
    void planKey;
    const [w, a, p] = untrack(() => [workspaceId, plan.appId, plan.id] as const);
    const mine = ++generation;
    view = null;
    loading = true;
    loadProblem = '';
    editing = false;
    api
      .rollout(w, a, p)
      .then((r) => {
        if (mine !== generation) return;
        view = r.rollout;
        startDraft = localInputValue(r.rollout.apple?.startsAt ?? null);
        loading = false;
      })
      .catch((e) => {
        if (mine !== generation) return;
        loadProblem = planErrorMessage(e);
        loading = false;
      });
  });

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 30_000);
    return () => clearInterval(timer);
  });

  /** One request at a time, so two quick clicks cannot interleave their answers. */
  async function run(call: () => Promise<{ rollout: RolloutView }>): Promise<RolloutView | null> {
    if (busy) return null;
    busy = true;
    problem = '';
    try {
      const result = (await call()).rollout;
      view = result;
      startDraft = localInputValue(result.apple?.startsAt ?? null);
      onsummary(result.summary);
      return result;
    } catch (e) {
      problem = planErrorMessage(e);
      return null;
    } finally {
      busy = false;
    }
  }

  async function usePlanTemplate() {
    const template = chosen;
    if (!template) return;
    const body =
      template.kind === 'apple_phased'
        ? ({ kind: 'apple_phased', template: template.id } as const)
        : ({ kind: 'steps', template: template.id, steps: template.steps.map((s) => ({ percent: s.percent })) } as const);
    const result = await run(() => api.setRollout(workspaceId, plan.appId, plan.id, body));
    if (result) {
      editing = false;
      announcement = `Planned: ${template.name}.`;
      toast.success('Rollout plan saved. Nothing was sent to a store.');
    }
  }

  async function act(step: RolloutStep, action: 'complete' | 'skip' | 'reopen', fromStore = false) {
    const result = await run(() => api.rolloutStep(workspaceId, plan.appId, plan.id, step.id, action, { fromStore }));
    if (result) {
      const verb = action === 'complete' ? (fromStore ? 'Confirmed from the store' : 'Done') : action === 'skip' ? 'Skipped' : 'Reopened';
      announcement = `${verb}: step at ${formatPercent(step.percent)}.`;
    }
  }

  function startEdit() {
    draft = draftFromSteps(steps);
    rowProblems = {};
    generalProblems = [];
    problem = '';
    editing = true;
  }

  async function saveEdit(event: SubmitEvent) {
    event.preventDefault();
    const checked = draftToBody(draft, { planCreatedAt: plan.createdAt, existing: steps });
    if (!checked.ok) {
      rowProblems = checked.rows;
      generalProblems = checked.general;
      return;
    }
    rowProblems = {};
    generalProblems = [];
    const template = view?.template;
    const result = await run(() =>
      api.setRollout(workspaceId, plan.appId, plan.id, { kind: 'steps', ...(template ? { template } : {}), steps: checked.steps }),
    );
    if (result) {
      editing = false;
      announcement = 'Rollout steps saved.';
    }
  }

  async function saveStart(event: SubmitEvent) {
    event.preventDefault();
    const startsAt = parseLocalInput(startDraft);
    if (startsAt !== null && Number.isNaN(startsAt)) {
      startProblem = 'A date and time.';
      return;
    }
    startProblem = '';
    const template = view?.template;
    const result = await run(() => api.setRollout(workspaceId, plan.appId, plan.id, { kind: 'apple_phased', ...(template ? { template } : {}), startsAt }));
    if (result) announcement = 'Expected start saved.';
  }

  async function clear() {
    const result = await run(() => api.clearRollout(workspaceId, plan.appId, plan.id));
    if (result) {
      confirmClear = false;
      editing = false;
      toast.success('The rollout plan was removed. Nothing in a store was changed.');
    }
  }
</script>

<section class="card" aria-labelledby="{uid}-title" aria-busy={loading}>
  <div class="card-header">
    <div>
      <h2 id="{uid}-title">Staged rollout</h2>
      <p>
        Planning only: this does not start, change or stop a rollout in {platformMeta(plan.appPlatform).consoleName}. Marking a step done only records it here.
      </p>
    </div>
    {#if view && view.kind !== null && canWrite && !editing}
      <div class="row">
        {#if view.kind === 'steps'}<Button size="sm" icon="edit" disabled={busy} onclick={startEdit}>Edit steps</Button>{/if}
        <Button size="sm" variant="ghost" icon="trash" disabled={busy} onclick={() => { problem = ''; confirmClear = true; }}>Remove the plan</Button>
      </div>
    {/if}
  </div>

  <p class="visually-hidden" role="status">{announcement}</p>
  {#if problem}<Alert tone="error">{problem}</Alert>{/if}

  {#if loading}
    <div role="status" aria-label="Loading the rollout plan" class="stack">
      <Skeleton width="60%" height="16px" />
      <Skeleton width="80%" height="16px" />
    </div>
  {:else if loadProblem}
    <Alert tone="error" title="Could not load the rollout plan">{loadProblem}</Alert>
  {:else if view}
    {#if view.kind === null}
      <p class="muted line">
        {canWrite ? 'No rollout is planned for this version. Pick a template to start; you can change the steps afterwards.' : 'No rollout is planned for this version.'}
      </p>
    {:else}
      <p class="line headline">{rolloutHeadline(view.summary)}</p>
    {/if}

    {#if view.kind === 'steps' && comparison}
      <div class="compare" class:warn={comparisonTone(comparison) === 'warn'} class:ok={comparisonTone(comparison) === 'ok'}>
        <div class="compare-head">
          <h3>Store and plan</h3>
          <Badge tone={comparisonTone(comparison)} dot>{comparisonLabel(comparison)}</Badge>
        </div>
        <dl class="facts">
          <div>
            <dt>The store says</dt>
            <dd>
              {#if store && store.percent !== null}
                <strong>{formatPercent(store.percent)}</strong>{store.inferred ? ' (live for everyone)' : ''}
              {:else if store}
                No share reported
              {:else}
                Nothing synced for this version
              {/if}
              {#if store}
                <span class="muted small">
                  Observed from {storeSource}, read only{store.syncedAt !== null ? ', synced ' : ''}{#if store.syncedAt !== null}<time datetime={new Date(store.syncedAt).toISOString()} title={fullTime(store.syncedAt)}>{timeAgo(store.syncedAt, now)}</time>{/if}.
                </span>
              {/if}
            </dd>
          </div>
          <div>
            <dt>The plan says</dt>
            <dd>
              {#if comparison.planStep}
                <strong>Step {comparison.planStep.index} of {comparison.planStep.total}</strong> = {formatPercent(comparison.planStep.percent)}
              {:else}
                No step done yet
              {/if}
            </dd>
          </div>
        </dl>
        <p class="line small">{comparison.message}</p>
      </div>
    {/if}

    {#if view.kind === 'steps'}
      {#if editing}
        <form class="editor" onsubmit={saveEdit}>
          {#if generalProblems.length > 0}
            <Alert tone="error">{generalProblems.join(' ')}</Alert>
          {/if}
          <ul class="edit-rows">
            {#each draft as row, i (row.key)}
              <li class="edit-row">
                <div class="edit-grid">
                  <div class="field">
                    <label for="{uid}-p-{row.key}">Step {i + 1} percent</label>
                    <input id="{uid}-p-{row.key}" type="text" inputmode="numeric" maxlength="3" autocomplete="off" bind:value={row.percent} disabled={busy || row.status === 'done'} aria-invalid={rowProblems[row.key] !== undefined} aria-describedby={rowProblems[row.key] ? `${uid}-e-${row.key}` : undefined} />
                  </div>
                  <div class="field">
                    <label for="{uid}-t-{row.key}">Planned time (your time zone)</label>
                    <input id="{uid}-t-{row.key}" type="datetime-local" bind:value={row.plannedAt} disabled={busy || row.status === 'done'} />
                  </div>
                  <div class="field">
                    <label for="{uid}-n-{row.key}">Note</label>
                    <input id="{uid}-n-{row.key}" type="text" maxlength="200" bind:value={row.note} disabled={busy} />
                  </div>
                  <div class="edit-tools">
                    <Button size="sm" variant="ghost" iconOnly icon="trash" label="Remove step {i + 1}" disabled={busy || row.status === 'done'} onclick={() => { draft = draft.filter((d) => d.key !== row.key); }} />
                  </div>
                </div>
                {#if row.status !== 'planned'}<p class="hint">This step is {row.status === 'done' ? 'done, so its percentage and time are kept' : 'skipped'}.</p>{/if}
                {#if rowProblems[row.key]}<p id="{uid}-e-{row.key}" class="field-error" role="alert">{rowProblems[row.key]}</p>{/if}
              </li>
            {/each}
          </ul>
          <p class="hint">Percentages must go up from one step to the next. Steps are put in order of percentage when you save.</p>
          <div class="row">
            <Button icon="plus" disabled={busy || draft.length >= MAX_ROLLOUT_STEPS} onclick={() => { draft = addDraftStep(draft); }}>Add a step</Button>
            <Button type="submit" variant="primary" loading={busy}>Save steps</Button>
            <Button disabled={busy} onclick={() => { editing = false; }}>Cancel</Button>
          </div>
        </form>
      {:else}
        <ol class="steps">
          {#each steps as step, i (step.id)}
            {@const chip = stepChip(step)}
            <li class="step" class:done={step.status === 'done'} class:skipped={step.status === 'skipped'}>
              <div class="step-main">
                <div class="step-head">
                  <span class="muted small">Step {i + 1} of {steps.length}</span>
                  <strong class="percent">{formatPercent(step.percent)}</strong>
                  <Badge tone={chip.tone} dot>{chip.label}</Badge>
                  {#if comparison?.confirmStepId === step.id}<Badge tone="info">The store has reached this</Badge>{/if}
                </div>
                <div class="bar" aria-hidden="true"><div class="fill" style:width="{barWidth(step.percent)}%"></div></div>
                <p class="meta muted small">
                  <span>Planned: {step.plannedAt === null ? 'no time set' : formatPlannedAt(step.plannedAt)}</span>
                  {#if step.status === 'done' && step.doneAt !== null}
                    <span>
                      {step.doneBy?.name ? `Done by ${step.doneBy.name}` : 'Done'},
                      <time datetime={new Date(step.doneAt).toISOString()} title={fullTime(step.doneAt)}>{timeAgo(step.doneAt, now)}</time>{step.doneSource === 'store' ? ', confirmed from the store' : ''}
                    </span>
                  {/if}
                  {#if step.note}<span>{step.note}</span>{/if}
                </p>
              </div>
              {#if canWrite}
                <div class="tools">
                  {#if step.status === 'planned'}
                    {#if comparison?.confirmStepId === step.id}
                      <Button size="sm" variant="primary" disabled={busy} onclick={() => act(step, 'complete', true)}>Confirm from the store</Button>
                    {/if}
                    <Button size="sm" variant={comparison?.confirmStepId === step.id ? 'secondary' : 'primary'} disabled={busy || !checkRolloutAction(steps, step.id, 'complete').ok} onclick={() => act(step, 'complete')}>Mark done</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onclick={() => act(step, 'skip')}>Skip</Button>
                  {:else}
                    <Button size="sm" disabled={busy || !checkRolloutAction(steps, step.id, 'reopen').ok} onclick={() => act(step, 'reopen')}>Reopen</Button>
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ol>
        {#if canWrite && steps.some((s) => s.status === 'planned') && !checkRolloutAction(steps, steps.find((s) => s.status === 'planned')?.id ?? '', 'complete').ok}
          <p class="hint">Earlier steps are completed or skipped first.</p>
        {/if}
      {/if}
    {:else if view.kind === 'apple_phased' && view.apple}
      <div class="apple">
        <p class="line small">{view.apple.note}</p>
        <table class="schedule">
          <caption class="visually-hidden">Apple's phased release schedule</caption>
          <thead><tr><th scope="col">Day</th><th scope="col">Share of users</th><th scope="col">Date (UTC)</th></tr></thead>
          <tbody>
            {#each view.apple.schedule as day (day.day)}
              <tr>
                <th scope="row">Day {day.day}</th>
                <td>
                  <div class="bar inline" aria-hidden="true"><div class="fill" style:width="{barWidth(day.percent)}%"></div></div>
                  {formatPercent(day.percent)}
                </td>
                <td>{day.date ? formatTargetDate(day.date) : 'Not set'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        {#if store}
          <p class="line small muted">
            The store reports this version as “{store.rawState ?? 'unknown'}”{store.status ? ` (${store.status.replace(/_/g, ' ')})` : ''}. Apple's phased release is not read from the store, so the share it has reached is not shown and nothing is compared.
          </p>
        {/if}
        {#if canWrite}
          <form class="start" onsubmit={saveStart}>
            <div class="field">
              <label for="{uid}-start">Expected day 1 (your time zone)</label>
              <input id="{uid}-start" type="datetime-local" bind:value={startDraft} disabled={busy} aria-invalid={startProblem !== ''} />
              {#if startProblem}<p class="field-error" role="alert">{startProblem}</p>{/if}
            </div>
            <Button type="submit" loading={busy}>Save</Button>
          </form>
        {/if}
      </div>
    {/if}

    {#if canWrite && !editing}
      <div class="template">
        <div class="field">
          <label for="{uid}-template">{view.kind === null ? 'Plan a rollout from a template' : 'Replace the plan with a template'}</label>
          <select id="{uid}-template" bind:value={templateId} disabled={busy}>
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name}</option>
            {/each}
          </select>
          <p class="hint">{chosen?.description ?? ''}{view.kind !== null && hasDone ? ' Steps that are done cannot be replaced: reopen them first.' : ''}</p>
        </div>
        <Button disabled={busy || !chosen} loading={busy} onclick={usePlanTemplate}>{view.kind === null ? 'Plan this rollout' : 'Replace'}</Button>
      </div>
    {/if}
  {/if}
</section>

{#if canWrite}
  <Modal bind:open={confirmClear} size="sm" title="Remove the rollout plan?" dismissible={!busy}>
    <div class="stack">
      <p>The steps of this plan{hasDone ? ', including the ones marked done,' : ''} will be removed.</p>
      <p class="muted">Nothing in a store is changed.</p>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
    </div>
    {#snippet footer()}
      <Button disabled={busy} onclick={() => (confirmClear = false)}>Cancel</Button>
      <Button variant="danger-solid" loading={busy} onclick={clear}>Remove the plan</Button>
    {/snippet}
  </Modal>
{/if}

<style>
  .line {
    margin: 0 0 var(--space-3);
  }

  .headline {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .small {
    font-size: 0.9375rem;
  }

  .compare {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  /* A mismatch is said in words and by a thicker edge, not by color alone. */
  .compare.warn {
    background: var(--warn-bg);
    border-color: var(--warn-line);
    border-left: 4px solid var(--warn);
  }

  .compare.ok {
    border-color: var(--ok-line);
  }

  .compare-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .compare h3 {
    margin: 0;
    font-size: var(--text-base);
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: var(--space-2) var(--space-4);
    margin: 0;
  }

  .facts dt {
    font-size: 0.8125rem;
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
  }

  .compare .line {
    margin: 0;
  }

  .steps {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0 0 var(--space-4);
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .step {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
  }

  .step + .step {
    border-top: 1px solid var(--line);
  }

  .step-main {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    flex: 1 1 320px;
  }

  .step-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    align-items: center;
  }

  .percent {
    font-size: var(--text-lg);
  }

  .step.skipped .percent {
    color: var(--muted);
    text-decoration: line-through;
  }

  .bar {
    height: var(--space-2);
    overflow: hidden;
    background: var(--surface-sunken);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-full);
  }

  .bar.inline {
    display: inline-block;
    width: 96px;
    margin-right: var(--space-2);
    vertical-align: middle;
  }

  .fill {
    height: 100%;
    background: var(--accent);
  }

  .step.done .fill {
    background: var(--ok);
  }

  .step.skipped .fill {
    background: var(--line-strong);
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-3);
    margin: 0;
  }

  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    align-items: center;
  }

  .editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }

  .edit-rows {
    display: flex;
    flex-direction: column;
    padding: 0;
    margin: 0;
    list-style: none;
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .edit-row {
    padding: var(--space-3) var(--space-4);
  }

  .edit-row + .edit-row {
    border-top: 1px solid var(--line);
  }

  .edit-grid {
    display: grid;
    grid-template-columns: 110px minmax(0, 1.2fr) minmax(0, 1.5fr) auto;
    gap: var(--space-3);
    align-items: end;
  }

  .edit-grid .field {
    margin: 0;
  }

  .schedule {
    width: 100%;
    margin-bottom: var(--space-3);
    border-collapse: collapse;
  }

  .schedule th,
  .schedule td {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    border-bottom: 1px solid var(--line);
  }

  .start,
  .template {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-end;
    margin-top: var(--space-3);
  }

  .start .field,
  .template .field {
    flex: 1 1 280px;
    margin: 0;
  }

  @media (max-width: 720px) {
    .edit-grid {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }
  }
</style>
