<!--
  CompetitorReviewSchedule: when Kiln reads the public reviews of the competitors you follow (Competitors section, one per app record).
  Off by default; daily or weekly in UTC or in your time zone, with the number of competitors per run and the number of newest reviews
  kept per read as cost guards; pause and resume; and, per competitor, its own schedule. Each competitor shows the state: "Reads every
  Monday", when it was last read and how many reviews were new, when it reads next, and why a read failed. Apple only: Google Play has no
  official API for the reviews of another app, and Kiln does not scrape it. Reading is independent of the AI switches.
  The server plans and runs the reads through its job queue (the same limits as other store reads); this only edits and shows the schedule.
  Props: api, workspaceId, app, canWrite (aso.write), now, version (bump to read the state again).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { ReviewScheduleMode } from '@kiln/core';
  import { asoErrorMessage } from '../../lib/aso/aso.ts';
  import {
    competitorStateLines,
    isScheduleDirty,
    modeText,
    scheduleChanges,
    scheduleModes,
    scheduleToForm,
    type ReviewScheduleView,
    type ScheduleErrors,
    type ScheduleForm,
    validateSchedule,
    weekdayName,
    weekdayOrder,
  } from '../../lib/aso/competitor-review-schedule.ts';
  import type { Api } from '../../lib/api.ts';
  import { formatDateTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import SaveBar from '../app/settings/SaveBar.svelte';

  let { api, workspaceId, app, canWrite, now, version }: { api: Api; workspaceId: string; app: AppSummary; canWrite: boolean; now: number; version: number } = $props();

  const uid = $props.id();
  const appleOnly = $derived(app.platform === 'android');
  let view = $state<ReviewScheduleView | null>(null);
  let form = $state<ScheduleForm | null>(null);
  let errors = $state<ScheduleErrors>({});
  let problem = $state('');
  let saving = $state(false);
  let failed = $state(false);
  let busyCompetitor = $state('');

  /** The time zone of this browser, offered next to UTC. */
  const browserZone = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  })();

  function adopt(next: ReviewScheduleView) {
    view = next;
    form = scheduleToForm(next);
    errors = {};
  }

  $effect(() => {
    void version;
    const ws = workspaceId;
    const id = app.id;
    untrack(() => {
      failed = false;
      api
        .asoCompetitorReviewSchedule(ws, id)
        .then((next) => {
          // Keep what is being typed while the state refreshes.
          if (view !== null && form !== null && isScheduleDirty(view, form)) view = next;
          else adopt(next);
        })
        .catch(() => {
          failed = true;
        });
    });
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!view || !form || saving) return;
    errors = validateSchedule(form, view.limits);
    if (Object.keys(errors).length > 0) return;
    saving = true;
    problem = '';
    try {
      adopt(await api.updateAsoCompetitorReviewSchedule(workspaceId, app.id, scheduleChanges(view, form)));
      toast.success(t('aso:schedule.saved'));
    } catch (e) {
      problem = asoErrorMessage(e, t('aso:schedule.saveFailed'));
    } finally {
      saving = false;
    }
  }

  async function setPaused(paused: boolean) {
    if (saving) return;
    saving = true;
    problem = '';
    try {
      adopt(await api.updateAsoCompetitorReviewSchedule(workspaceId, app.id, { paused }));
      toast.success(paused ? t('aso:schedule.pausedToast') : t('aso:schedule.resumedToast'));
    } catch (e) {
      problem = asoErrorMessage(e, t('aso:schedule.saveFailed'));
    } finally {
      saving = false;
    }
  }

  async function override(competitorId: string, value: string, weekday: number) {
    busyCompetitor = competitorId;
    problem = '';
    try {
      const mode = value === 'inherit' ? null : (value as ReviewScheduleMode);
      adopt(await api.updateAsoCompetitorReviewOverride(workspaceId, app.id, competitorId, { mode, ...(mode === 'weekly' ? { weekday } : {}) }));
    } catch (e) {
      problem = asoErrorMessage(e, t('aso:schedule.saveFailed'));
    } finally {
      busyCompetitor = '';
    }
  }

  const field = (name: string) => `${uid}-${name}`;
</script>

<section class="schedule stack" aria-label={t('aso:schedule.region')} data-testid="review-schedule">
  <h4 class="title">{t('aso:schedule.title')}</h4>
  {#if appleOnly}
    <p class="muted" data-testid="schedule-apple-only">{t('aso:schedule.appleOnly')}</p>
  {:else if failed && view === null}
    <Alert tone="error">{t('aso:schedule.loadFailed')}</Alert>
  {:else if !view || !form}
    <Skeleton width="100%" height="80px" />
  {:else}
    <p class="muted">{t('aso:schedule.sub')}</p>
    <form class="stack" onsubmit={(e) => void save(e)} novalidate>
      <fieldset class="group" disabled={!canWrite}>
        <legend>{t('aso:schedule.modeLegend')}</legend>
        <div class="row wrap">
          {#each scheduleModes as mode (mode)}
            <label class="option"><input type="radio" name={field('mode')} value={mode} bind:group={form.mode} />{t(modeText[mode])}</label>
          {/each}
          {#if form.mode === 'weekly'}
            <label class="inline">
              <span class="visually-hidden">{t('aso:schedule.weekday')}</span>
              <select bind:value={form.weekday} aria-label={t('aso:schedule.weekday')}>
                {#each weekdayOrder as day (day)}<option value={day}>{weekdayName(day)}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
        {#if form.mode !== 'off'}
          <div class="row wrap">
            <label class="inline">
              <span>{t('aso:schedule.zone')}</span>
              <select bind:value={form.timezone}>
                <option value="">{t('aso:schedule.zoneUtc')}</option>
                {#if browserZone !== ''}<option value={browserZone}>{t('aso:schedule.zoneYours', { zone: browserZone })}</option>{/if}
                {#if form.timezone !== '' && form.timezone !== browserZone}<option value={form.timezone}>{form.timezone}</option>{/if}
              </select>
            </label>
            <label class="inline">
              <span>{t('aso:schedule.maxCompetitors')}</span>
              <input class="num" inputmode="numeric" bind:value={form.maxCompetitors} aria-invalid={errors.maxCompetitors ? 'true' : undefined} />
            </label>
            <label class="inline">
              <span>{t('aso:schedule.maxReviews')}</span>
              <input class="num" inputmode="numeric" bind:value={form.maxReviews} aria-invalid={errors.maxReviews ? 'true' : undefined} />
            </label>
          </div>
          {#if errors.maxCompetitors}<p class="field-error" role="alert">{errors.maxCompetitors}</p>{/if}
          {#if errors.maxReviews}<p class="field-error" role="alert">{errors.maxReviews}</p>{/if}
          <p class="muted small">{t('aso:schedule.guards')}</p>
        {/if}
      </fieldset>
      {#if problem}<Alert tone="error">{problem}</Alert>{/if}
      {#if canWrite}
        <SaveBar type="submit" dirty={isScheduleDirty(view, form)} {saving} ondiscard={() => view && adopt(view)} />
      {:else}
        <p class="muted small">{t('aso:schedule.viewOnly')}</p>
      {/if}
    </form>

    {#if view.schedule.mode !== 'off' || view.competitors.some((c) => c.override !== null && c.override.mode !== 'off')}
      <div class="row wrap state">
        {#if view.paused}
          <p class="grow" data-testid="schedule-paused"><strong>{t('aso:schedule.paused')}</strong></p>
        {:else if view.nextRunAt !== null}
          <p class="grow muted" data-testid="schedule-next">{t('aso:schedule.nextRun', { when: formatDateTime(view.nextRunAt) })}</p>
        {/if}
        {#if canWrite && view.schedule.mode !== 'off'}
          <Button size="sm" icon={view.paused ? 'play' : 'pause'} loading={saving} onclick={() => void setPaused(!view?.paused)}>{view.paused ? t('aso:schedule.resume') : t('aso:schedule.pause')}</Button>
        {/if}
      </div>
    {/if}

    {#if view.competitors.length > 0}
      <ul class="plain list">
        {#each view.competitors as c (c.competitorId)}
          {@const lines = competitorStateLines(c, view.paused, now)}
          {@const own = c.override === null ? 'inherit' : c.override.mode}
          <li class="item" data-testid="schedule-competitor">
            <div class="who">
              <strong>{c.name}</strong>
              <span class="muted">{lines.schedule}</span>
              {#if lines.last}<span class="muted">{lines.last}</span>{/if}
              {#if lines.next}<span class="muted">{lines.next}</span>{/if}
              {#if lines.failure}<span class="problem" role="status" data-testid="schedule-failure">{lines.failure}</span>{/if}
            </div>
            {#if c.supported}
              <label class="inline">
                <span class="visually-hidden">{t('aso:schedule.override', { name: c.name })}</span>
                <select
                  value={own}
                  disabled={!canWrite || busyCompetitor === c.competitorId}
                  aria-label={t('aso:schedule.override', { name: c.name })}
                  onchange={(e) => void override(c.competitorId, e.currentTarget.value, c.override?.weekday ?? view?.schedule.weekday ?? 1)}
                >
                  <option value="inherit">{t('aso:schedule.followApp')}</option>
                  {#each scheduleModes as mode (mode)}<option value={mode}>{t(modeText[mode])}</option>{/each}
                </select>
              </label>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .title {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    padding: 0;
    margin: 0;
    border: 0;
  }

  .group legend {
    padding: 0;
    margin-bottom: var(--space-1);
    font-weight: var(--weight-semibold);
  }

  .option {
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
    font-weight: 400;
  }

  .inline {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .num {
    width: 5rem;
  }

  .small {
    margin: 0;
    font-size: var(--text-xs);
  }

  .state {
    align-items: center;
    justify-content: space-between;
  }

  .state p {
    margin: 0;
  }

  .grow {
    flex: 1 1 14rem;
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .item {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    padding: var(--space-2) 0;
    border-top: 1px solid var(--border);
  }

  .who {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
  }

  .problem {
    color: var(--ink);
    font-size: var(--text-xs);
  }
</style>
