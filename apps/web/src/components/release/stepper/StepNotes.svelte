<!--
  StepNotes: the second step of "Prepare release": what is new, one text per language. Per language: the editor with the
  count against the store limit; "Reuse earlier notes" (the texts earlier releases used, with the release, version or track
  and the date of each, App Store and Google Play); "Copy to the other languages"; "Translate" (the translation provider of Settings >
  Translation, or the AI provider of Settings > AI, from another language of the editors into this one) and, for the whole step,
  "Translate all from ..." (one language into every other shown language, asking before it replaces text). Translating only changes the
  text in the editors and says so; the text is sent to the provider that is named before anything is sent. For an App Store release, "Use TestFlight
  notes" fills the editors from the notes of a build, when they were read; it says plainly when they were not read or the
  build has none. Every button only changes the text in the editors. "Stage the notes" saves them in our own database
  (docs/api/staged-changes.md and releases-write.md); nothing reaches a store from here.
  "Promote to production" (docs/adr/0025-play-release-checks.md): the notes of the release being promoted are put in the editors when the
  step is opened (ReleaseStepper reads them; never over text the person wrote or staged) and one sentence says where they came from.
  Props: api, workspaceId, role, app, view (the staged changes), editable (the read of the editable release), candidates
  (the builds, for their TestFlight notes), chosenBuildId, track (Google Play target track), locales (every language
  shown), drafts (bindable: the text of each language in the editors), extra (bindable: languages the person added).
-->
<script lang="ts">
  import { can, type Role, type StagedChangesView, supports } from '@kiln/core';
  import type { Api } from '../../../lib/api.ts';
  import { type BuildCandidate, type EditableRelease, type ReleaseCandidates, hasTestNotes } from '../../../lib/release-candidates.ts';
  import { type Promote } from '../../../lib/play-promote.ts';
  import { trackLabel } from '../../../lib/portfolio.ts';
  import {
    type NotesHistory,
    type PromoteNotesState,
    promoteNotesLine,
    copyToLocales,
    historyStoreLine,
    isNoteLocale,
    noteRows,
    overwriteCount,
    reuseOptions,
    stateLabel,
    testFlightLine,
    unsavedLocales,
    useTestFlightNotes } from '../../../lib/release-notes.ts';
  import {
    type ChunkAnswer,
    type EngineState,
    type TranslateEngine,
    aiEngine,
    applyTranslations,
    defaultSource,
    languagesWithText,
    machineEngine,
    providerName,
    replaceText,
    translateErrorMessage,
    translateLines,
    translatePlan } from '../../../lib/release-notes-translate.ts';
  import { aiStore } from '../../../lib/ai/store.svelte.ts';
  import { loadTranslationConfig, type TranslationConfig } from '../../../lib/settings.ts';
  import { stagedField, stagedNotes, storeNotes } from '../../../lib/release-stepper.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import Disclosure from '../../ui/Disclosure.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';
  import { untrack } from 'svelte';
  import { formatDate, formatList } from '../../../lib/i18n/format.ts';
  import { t } from '../../../lib/i18n/t.ts';

  let {
    api,
    workspaceId,
    role,
    app,
    view,
    editable,
    candidates,
    chosenBuildId,
    track,
    locales,
    promote = null,
    promoteNotes = null,
    drafts = $bindable({}),
    extra = $bindable([]) }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: AppSummary;
    view: StagedChangesView | null;
    editable: EditableRelease | null;
    candidates: ReleaseCandidates | null;
    chosenBuildId: string | null;
    track: string;
    locales: string[];
    promote?: Promote | null;
    promoteNotes?: PromoteNotesState | null;
    drafts?: Record<string, string>;
    extra?: string[];
  } = $props();

  const uid = $props.id();
  const apple = $derived(!supports(app.platform, 'releaseTracks'));
  const mayEdit = $derived(canStage(role));

  let history = $state<NotesHistory | null>(null);
  let historyState = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
  let historyMessage = $state('');
  let menuFor = $state('');
  let copyFor = $state('');
  let copyTargets = $state<string[]>([]);
  let newLocale = $state('');
  let staging = $state(false);
  let problem = $state('');
  let done = $state('');
  let tfNote = $state('');

  // Translate: one panel at a time ('*' is the whole step, else a language), the language it translates from, and what the last run did.
  let trOpen = $state('');
  let trSource = $state('');
  let trBusy = $state<'' | TranslateEngine>('');
  let trResult = $state<{ tone: 'ok' | 'warn' | 'error'; lines: string[] } | null>(null);
  let machineConfig = $state<TranslationConfig | null | undefined>(undefined);

  $effect(() => {
    const key = `${workspaceId}`;
    untrack(() => {
      if (key === '' || !mayEdit) return;
      if (can(role, 'settings.read')) void loadTranslationConfig(api, workspaceId).then((c) => (machineConfig = c));
      else machineConfig = null;
      if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
    });
  });

  const machine = $derived<EngineState>(machineEngine({ role, config: machineConfig }));
  const aiState = $derived<EngineState>(aiEngine({ role, config: aiStore.config(workspaceId), failed: aiStore.configFailed(workspaceId) }));
  const rows = $derived(noteRows({ platform: app.platform, locales, drafts, store: storeNotes(editable), staged: stagedNotes(view, app.platform) }));
  const unsaved = $derived(unsavedLocales(rows));
  const overs = $derived(rows.filter((r) => r.over).length);
  const builds = $derived<BuildCandidate[]>(candidates !== null && candidates.store === 'appstoreconnect' ? candidates.builds : []);
  const chosenFirst = $derived([...builds].sort((a, b) => Number(b.id === chosenBuildId) - Number(a.id === chosenBuildId)));
  const withNotes = $derived(chosenFirst.filter((b) => hasTestNotes(b.testNotes)));
  const dateText = (at: number): string => formatDate(at, { day: 'numeric', month: 'short', year: 'numeric' });

  /** What the editors show now, per language (a language nobody wrote in yet shows what is staged or in the store). */
  const shown = $derived(rows.reduce<Record<string, string>>((acc, r) => ({ ...acc, [r.locale]: r.draft }), {}));
  const plan = $derived(trOpen === '' || trSource === '' ? null : translatePlan(shown, locales, trSource, trOpen === '*' ? undefined : [trOpen]));
  const sources = $derived(languagesWithText(shown, locales).filter((l) => trOpen === '*' || l !== trOpen));
  const mayTranslate = $derived(mayEdit && locales.length > 1 && (machine.visible || aiState.visible));

  function openTranslate(scope: string) {
    trOpen = trOpen === scope ? '' : scope;
    trResult = null;
    menuFor = '';
    copyFor = '';
    if (trOpen !== '') trSource = defaultSource(shown, locales, scope === '*' ? '' : scope) ?? '';
  }

  async function translate(engine: TranslateEngine) {
    const p = plan;
    if (p === null || p.problem !== null || trBusy !== '') return;
    trBusy = engine;
    trResult = null;
    const answers: ChunkAnswer[] = [];
    let stopped = '';
    for (const chunk of p.chunks) {
      if (stopped !== '') {
        answers.push({ ok: false, message: stopped, locales: chunk });
        continue;
      }
      try {
        const result = await api.translateReleaseNotes(workspaceId, app.id, { engine, sourceLocale: p.source, text: p.text, targetLocales: chunk });
        answers.push({ ok: true, result });
      } catch (e) {
        stopped = translateErrorMessage(e);
        answers.push({ ok: false, message: stopped, locales: chunk });
      }
    }
    const applied = applyTranslations(shown, p.targets, answers);
    const next = { ...drafts };
    for (const l of applied.applied) next[l] = applied.drafts[l] as string;
    drafts = next;
    const first = answers.filter((a) => a.ok)[0];
    trResult = translateLines(applied, engine, first && first.ok ? providerName(engine, first.result.provider) : '');
    done = '';
    trBusy = '';
  }

  function setDraft(locale: string, text: string) {
    drafts = { ...drafts, [locale]: text };
  }

  async function openMenu(locale: string) {
    menuFor = menuFor === locale ? '' : locale;
    copyFor = '';
    if (menuFor === '' || historyState === 'loading' || historyState === 'ready') return;
    historyState = 'loading';
    historyMessage = '';
    try {
      const out = await api.releaseNotesHistory(workspaceId, app.id, { platform: app.platform });
      history = out.history;
      historyState = 'ready';
    } catch (e) {
      historyState = 'error';
      historyMessage = stagingError(e);
    }
  }

  function reuse(locale: string, text: string) {
    setDraft(locale, text);
    menuFor = '';
    done = '';
  }

  function openCopy(locale: string) {
    copyFor = copyFor === locale ? '' : locale;
    menuFor = '';
    copyTargets = locales.filter((l) => l !== locale);
  }

  const copyOverwrites = $derived(copyFor === '' ? 0 : overwriteCount(drafts, copyFor, copyTargets));

  function doCopy(locale: string) {
    const out = copyToLocales(rows.reduce<Record<string, string>>((acc, r) => ({ ...acc, [r.locale]: r.draft }), {}), locale, copyTargets);
    drafts = { ...drafts, ...out.drafts };
    done =
      out.overwritten > 0
        ? t('release-stepper:sn.copiedReplacing', { count: out.copied, locale, replaced: t('release-stepper:sn.texts', { count: out.overwritten }) })
        : t('release-stepper:sn.copied', { count: out.copied, locale });
    copyFor = '';
  }

  function useTestFlight(build: BuildCandidate) {
    const current = rows.reduce<Record<string, string>>((acc, r) => ({ ...acc, [r.locale]: r.draft }), {});
    const out = useTestFlightNotes(current, build.testNotes);
    drafts = { ...drafts, ...out.drafts };
    tfNote =
      out.filled.length === 0
        ? t('release-stepper:sn.tfNone')
        : out.skipped.length > 0
          ? t('release-stepper:sn.tfFilledSkipped', { filled: formatList(out.filled), number: build.buildNumber ?? '', skipped: formatList(out.skipped) })
          : t('release-stepper:sn.tfFilled', { filled: formatList(out.filled), number: build.buildNumber ?? '' });
  }

  function addLocale() {
    const value = newLocale.trim().replace(/_/g, '-');
    if (!isNoteLocale(value) || locales.indexOf(value) >= 0) return;
    extra = [...extra, value];
    newLocale = '';
  }

  async function stageNotes() {
    if (unsaved.length === 0 || staging) return;
    staging = true;
    problem = '';
    done = '';
    const failed: { locale: string; message: string }[] = [];
    let last: StagedChangesView | null = null;
    try {
      if (!apple && stagedField(view, 'track') === null) {
        // Google Play: a release note belongs to a track, and the server asks for it whenever anything of the release is staged.
        const staged = await api.stageReleaseField(workspaceId, app.id, { field: 'track', value: track.trim() === '' ? 'production' : track.trim() });
        last = staged.staged;
      }
      for (const locale of unsaved) {
        const text = (drafts[locale] ?? '').replace(/\r\n?/g, '\n').trim();
        try {
          const out = apple
            ? await api.stageText(workspaceId, app.id, { locale, field: 'release_notes', from: 'local', value: text })
            : await api.stageReleaseField(workspaceId, app.id, { field: 'release_notes', locale, value: text });
          last = out.staged;
        } catch (e) {
          failed.push({ locale, message: stagingError(e) });
        }
      }
      if (last) stagedStore.set(last);
      const ok = unsaved.length - failed.length;
      if (failed.length > 0) problem = failed.slice(0, 3).map((f) => t('release-stepper:sn.failedLocale', { locale: f.locale, message: f.message })).join(' ');
      if (ok > 0) {
        done = t('release-stepper:sn.staged', { count: ok });
        const keep: Record<string, string> = {};
        for (const k of Object.keys(drafts)) if (unsaved.indexOf(k) < 0 || failed.some((f) => f.locale === k)) keep[k] = drafts[k] as string;
        drafts = keep;
      }
    } catch (e) {
      problem = stagingError(e);
      void stagedStore.load(api, workspaceId, app.id);
    } finally {
      staging = false;
    }
  }
</script>

{#snippet translatePanel(pid: string, label: string, sourceLabel: string, scope: string)}
  <div class="panel" role="region" aria-label={label}>
    <div class="row">
      <label for="{pid}-src">{sourceLabel}</label>
      <select id="{pid}-src" bind:value={trSource} disabled={trBusy !== ''}>
        {#each sources as l (l)}<option value={l}>{l}</option>{/each}
        {#if sources.length === 0}<option value="">{t('release-stepper:sn.noLanguageText')}</option>{/if}
      </select>
    </div>
    {#if plan === null || plan.problem !== null}
      <p class="small bad">{plan === null ? t('release-stepper:sn.chooseLanguage') : plan.problem}</p>
    {:else if plan.replaces > 0}
      <p class="small bad">{scope === '*' ? `${replaceText(plan.replaces)} ${t('release-stepper:sn.fillsEmpty', { count: plan.fills })}` : t('release-stepper:sn.replacesLocale', { locale: scope })}</p>
    {:else}
      <p class="muted small">{scope === '*' ? t('release-stepper:sn.translatesInto', { count: plan.targets.length, list: formatList(plan.targets) }) : t('release-stepper:sn.fillsLocale', { locale: scope })}</p>
    {/if}
    <div class="row">
      {#if machine.visible}
        <Button size="sm" variant="primary" loading={trBusy === 'machine'} disabled={!machine.enabled || trBusy !== '' || plan === null || plan.problem !== null} onclick={() => translate('machine')}>{scope === '*' ? t('release-stepper:sn.translateAll') : t('release-stepper:sn.translate')}</Button>
      {/if}
      {#if aiState.visible}
        <Button size="sm" variant="primary" loading={trBusy === 'ai'} disabled={!aiState.enabled || trBusy !== '' || plan === null || plan.problem !== null} onclick={() => translate('ai')}>{scope === '*' ? t('release-stepper:sn.translateAllAi') : t('release-stepper:sn.translateAi')}</Button>
      {/if}
      <Button size="sm" variant="ghost" disabled={trBusy !== ''} onclick={() => (trOpen = '')}>{t('common:action.close')}</Button>
    </div>
    {#each [machine, aiState] as e, i (i)}
      {#if e.visible && !e.enabled && e.reason}
        <p class="muted small">{t('release-stepper:sn.engineReason', { engine: i === 0 ? t('release-stepper:sn.translate') : t('release-stepper:sn.translateAi'), reason: e.reason })}{#if e.href} <a class="link" href={e.href}>{t('release-stepper:sn.openSettings')}</a>{/if}</p>
      {/if}
    {/each}
    {#if (machine.visible && machine.enabled && machine.sends) || (aiState.visible && aiState.enabled && aiState.sends)}
      <p class="muted small">
        {#if machine.visible && machine.enabled}<span>{t('release-stepper:sn.sendsMachine', { sends: machine.sends })}</span>{/if}
        {#if aiState.visible && aiState.enabled}<span>{t('release-stepper:sn.sendsAi', { sends: aiState.sends })}</span>{/if}
        {t('release-stepper:sn.translateNote')}
      </p>
    {/if}
    {#if trResult}
      <Alert tone={trResult.tone}>{#each trResult.lines as line (line)}<span class="tl">{line}</span>{/each}</Alert>
    {/if}
  </div>
{/snippet}

<div class="stack">
  <p class="lead muted">
    {t('release-stepper:sn.lead')}
    <InfoTip label={t('release-stepper:sn.tipLabel')} text={t('release-stepper:sn.tipText')} />
  </p>

  {#if !apple && promote !== null && promoteNotes !== null}
    {@const line = promoteNotesLine(promoteNotes, trackLabel(promote.from).toLowerCase(), promote.codes)}
    <Alert tone={line.tone}>{line.text}</Alert>
  {/if}

  {#if apple}
    <Disclosure summary={t('release-stepper:sn.reuseTf')} stateKey="stepper-notes-testflight-{app.id}">
    <section class="tf" aria-label={t('release-stepper:sn.tfNotes')}>
      {#if candidates === null}
        <p class="muted small">{t('release-stepper:sn.buildsNotRead')}</p>
      {:else if builds.length === 0}
        <p class="muted small">{t('release-stepper:sn.noBuilds')}</p>
      {:else}
        <ul class="tfs">
          {#each chosenFirst.slice(0, 6) as b (b.id)}
            {@const label = b.buildNumber !== null ? t('release-stepper:chosen.build', { number: b.buildNumber }) : t('release-stepper:sn.thisBuild')}
            <li>
              <span class="small">{b.id === chosenBuildId ? t('release-stepper:sn.lineChosen', { line: testFlightLine(b.testNotes, label) }) : testFlightLine(b.testNotes, label)}</span>
              {#if hasTestNotes(b.testNotes)}
                <Button size="sm" disabled={!mayEdit} onclick={() => useTestFlight(b)}>{t('release-stepper:sn.useTf')}</Button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if withNotes.length === 0}<p class="muted small">{t('release-stepper:sn.noTfNotes')}</p>{/if}
        {#if tfNote}<p class="small" role="status">{tfNote}</p>{/if}
      {/if}
    </section>
    </Disclosure>
  {/if}

  {#if mayTranslate && rows.length > 1}
    <section class="locale" aria-label={t('release-stepper:sn.translateAllLanguages')}>
      <div class="head">
        <h3>{t('release-stepper:sn.allLanguages')}</h3>
        <span class="spacer"></span>
        <Button size="sm" aria-expanded={trOpen === '*'} disabled={staging || trBusy !== ''} onclick={() => openTranslate('*')}>{t('release-stepper:sn.translateAllFrom')}</Button>
      </div>
      {#if trOpen === '*'}
        {@render translatePanel(`${uid}-all`, t('release-stepper:sn.translateAllLanguages'), t('release-stepper:sn.translateAllFromLabel'), '*')}
      {/if}
    </section>
  {/if}

  {#each rows as row (row.locale)}
    {@const id = `${uid}-${row.locale}`}
    <section class="locale" aria-labelledby="{id}-h">
      <div class="head">
        <h3 id="{id}-h">{row.locale}</h3>
        <Badge tone={row.state === 'edited' ? 'warn' : row.state === 'staged' ? 'info' : row.state === 'same' ? 'ok' : 'neutral'}>{stateLabel(row.state)}</Badge>
        <span class="count" class:over={row.over}>{row.chars} / {row.limit}</span>
        <span class="spacer"></span>
        <Button size="sm" aria-expanded={menuFor === row.locale} disabled={!mayEdit} onclick={() => openMenu(row.locale)}>{t('release-stepper:sn.reuseEarlier')}</Button>
        {#if locales.length > 1}<Button size="sm" aria-expanded={copyFor === row.locale} disabled={!mayEdit || row.draft.trim() === ''} onclick={() => openCopy(row.locale)}>{t('release-stepper:sn.copyToOthers')}</Button>{/if}
        {#if mayTranslate}<Button size="sm" aria-expanded={trOpen === row.locale} aria-label={t('release-stepper:sn.translateInto', { locale: row.locale })} disabled={staging || trBusy !== ''} onclick={() => openTranslate(row.locale)}>{t('release-stepper:sn.translateEllipsis')}</Button>{/if}
      </div>
      <label class="visually-hidden" for="{id}-text">{t('release-stepper:sn.whatIsNew', { locale: row.locale })}</label>
      <textarea id="{id}-text" rows="5" value={row.draft} disabled={!mayEdit || staging || trBusy !== ''} oninput={(e) => setDraft(row.locale, e.currentTarget.value)}></textarea>
      {#if row.over}<p class="small bad">{t('release-stepper:sn.overLimit', { count: row.chars - row.limit })}</p>{/if}

      {#if menuFor === row.locale}
        <div class="panel" role="region" aria-label={t('release-stepper:sn.earlierNotes', { locale: row.locale })}>
          {#if historyState === 'loading'}
            <div role="status" aria-label={t('release-stepper:sn.readingEarlier')}><Skeleton width="60%" height="14px" /></div>
          {:else if historyState === 'error'}
            <p class="small bad">{historyMessage}</p>
          {:else if history}
            {@const options = reuseOptions(history, row.locale, app.platform, row.draft, dateText)}
            {@const line = historyStoreLine(history.store)}
            {#if line}<p class="muted small">{line}</p>{/if}
            {#if options.length === 0}
              <p class="muted small">{t('release-stepper:sn.noEarlier', { locale: row.locale })}</p>
            {:else}
              <ul class="options">
                {#each options as o (o.text)}
                  <li>
                    <button type="button" class="option" disabled={o.same} onclick={() => reuse(row.locale, o.text)}>
                      <span class="pv">{o.preview || t('release-stepper:sn.emptyText')}</span>
                      {#each o.uses as u (u)}<span class="use">{u}</span>{/each}
                      {#if o.usesMore > 0}<span class="use">{t('release-stepper:sn.andMore', { count: o.usesMore })}</span>{/if}
                      {#if o.same}<span class="use">{t('release-stepper:sn.sameText')}</span>{/if}
                      {#if o.overLimit !== null}<span class="use bad">{t('release-stepper:sn.overStoreLimit', { count: o.overLimit })}</span>{/if}
                      {#if o.truncated}<span class="use">{t('release-stepper:sn.cutText')}</span>{/if}
                    </button>
                  </li>
                {/each}
              </ul>
              <p class="muted small">{t('release-stepper:sn.chooseNote')}</p>
            {/if}
          {/if}
        </div>
      {/if}

      {#if copyFor === row.locale}
        <div class="panel" role="region" aria-label={t('release-stepper:sn.copyAria', { locale: row.locale })}>
          <fieldset class="targets">
            <legend class="small">{t('release-stepper:sn.copyLegend', { locale: row.locale })}</legend>
            {#each locales.filter((l) => l !== row.locale) as target (target)}
              <label class="check"><input type="checkbox" checked={copyTargets.indexOf(target) >= 0} onchange={(e) => (copyTargets = e.currentTarget.checked ? [...copyTargets, target] : copyTargets.filter((c) => c !== target))} /> <span>{target}</span></label>
            {/each}
          </fieldset>
          {#if copyOverwrites > 0}<p class="small bad">{t('release-stepper:sn.replacesTexts', { count: copyOverwrites })}</p>{/if}
          <div class="row">
            <Button size="sm" variant="primary" disabled={copyTargets.length === 0} onclick={() => doCopy(row.locale)}>{t('common:action.copy')}</Button>
            <Button size="sm" variant="ghost" onclick={() => (copyFor = '')}>{t('common:action.cancel')}</Button>
          </div>
        </div>
      {/if}

      {#if trOpen === row.locale}
        {@render translatePanel(`${id}-tr`, t('release-stepper:sn.translateInto', { locale: row.locale }), t('release-stepper:sn.translateFrom'), row.locale)}
      {/if}
    </section>
  {/each}

  {#if rows.length === 0}
    <p class="muted">{t('release-stepper:sn.noLanguages')}</p>
  {/if}

  {#if mayEdit}
    <div class="add">
      <label for="{uid}-add">{t('release-stepper:sn.addLanguage')}</label>
      <input id="{uid}-add" type="text" placeholder={t('release-stepper:sn.addPlaceholder')} autocomplete="off" spellcheck="false" bind:value={newLocale} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLocale(); } }} />
      <Button size="sm" disabled={!isNoteLocale(newLocale) || locales.indexOf(newLocale.trim().replace(/_/g, '-')) >= 0} onclick={addLocale}>{t('release-stepper:sn.add')}</Button>
    </div>

    <div class="row step-actions">
      <Button loading={staging} disabled={unsaved.length === 0 || staging || overs > 0} onclick={stageNotes}>
        {unsaved.length > 0 ? t('release-stepper:sn.stageCount', { count: unsaved.length }) : t('release-stepper:sn.stage')}
      </Button>
      {#if overs > 0}<span class="small bad">{t('release-stepper:sn.shorten')}</span>{:else if unsaved.length === 0}<span class="muted small">{t('release-stepper:sn.nothingToStage')}</span>{/if}
    </div>
  {:else}
    <p class="muted small">{t('release-stepper:sn.needMember')}</p>
  {/if}

  {#if problem}<Alert tone="error" ondismiss={() => (problem = '')}>{problem}</Alert>{/if}
  {#if done}<Alert tone="ok" ondismiss={() => (done = '')}>{done}</Alert>{/if}
</div>

<style>
  h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .lead {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
  }

  .tf,
  .locale {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .tfs {
    display: grid;
    gap: var(--space-2);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .tfs li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .count {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .count.over,
  .bad {
    color: var(--bad-ink);
  }

  textarea {
    width: 100%;
    resize: vertical;
  }

  .tl {
    display: block;
  }

  select {
    min-width: 8rem;
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .panel {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .options {
    display: grid;
    gap: var(--space-2);
    max-height: 18rem;
    padding: 0;
    margin: 0;
    overflow: auto;
    list-style: none;
  }

  .option {
    display: grid;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
  }

  .option:disabled {
    cursor: default;
    background: var(--surface-sunken);
  }

  .pv {
    font-weight: var(--weight-medium);
    overflow-wrap: anywhere;
  }

  .use {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .use.bad {
    color: var(--bad-ink);
  }

  .targets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    padding: 0;
    margin: 0;
    border: 0;
  }

  .add,
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .add input {
    width: 12rem;
  }
</style>
