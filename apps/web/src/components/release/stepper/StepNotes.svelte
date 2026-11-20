<!--
  StepNotes: the second step of "Prepare release": what is new, one text per language. Per language: the editor with the
  count against the store limit; "Reuse earlier notes" (the texts earlier releases used, with the release, version or track
  and the date of each, App Store and Google Play); "Copy to the other languages". For an App Store release, "Use TestFlight
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
  import { type Role, type StagedChangesView, isApplePlatform } from '@mrm/core';
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
    useTestFlightNotes,
  } from '../../../lib/release-notes.ts';
  import { stagedField, stagedNotes, storeNotes } from '../../../lib/release-stepper.ts';
  import { canStage, stagingError } from '../../../lib/staged.ts';
  import { stagedStore } from '../../../lib/staged-store.svelte.ts';
  import type { AppSummary } from '../../../lib/types.ts';
  import Alert from '../../ui/Alert.svelte';
  import Badge from '../../ui/Badge.svelte';
  import Button from '../../ui/Button.svelte';
  import InfoTip from '../../ui/InfoTip.svelte';
  import Skeleton from '../../ui/Skeleton.svelte';

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
    extra = $bindable([]),
  }: {
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
  const apple = $derived(isApplePlatform(app.platform));
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

  const rows = $derived(noteRows({ platform: app.platform, locales, drafts, store: storeNotes(editable), staged: stagedNotes(view, app.platform) }));
  const unsaved = $derived(unsavedLocales(rows));
  const overs = $derived(rows.filter((r) => r.over).length);
  const builds = $derived<BuildCandidate[]>(candidates !== null && candidates.store === 'appstoreconnect' ? candidates.builds : []);
  const chosenFirst = $derived([...builds].sort((a, b) => Number(b.id === chosenBuildId) - Number(a.id === chosenBuildId)));
  const withNotes = $derived(chosenFirst.filter((b) => hasTestNotes(b.testNotes)));
  const dateText = (at: number): string => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

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
    done = `Copied the ${locale} text to ${out.copied} ${out.copied === 1 ? 'language' : 'languages'}${out.overwritten > 0 ? `, replacing ${out.overwritten} text${out.overwritten === 1 ? '' : 's'}` : ''}. Not staged yet.`;
    copyFor = '';
  }

  function useTestFlight(build: BuildCandidate) {
    const current = rows.reduce<Record<string, string>>((acc, r) => ({ ...acc, [r.locale]: r.draft }), {});
    const out = useTestFlightNotes(current, build.testNotes);
    drafts = { ...drafts, ...out.drafts };
    tfNote =
      out.filled.length === 0
        ? 'None of the TestFlight languages matches the languages shown here. Add the language first.'
        : `Filled ${out.filled.join(', ')} from the TestFlight notes of build ${build.buildNumber ?? ''}.${out.skipped.length > 0 ? ` Not used (not shown here): ${out.skipped.join(', ')}.` : ''} Not staged yet.`;
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
    const failed: string[] = [];
    let last: StagedChangesView | null = null;
    try {
      if (!apple && stagedField(view, 'track') === null) {
        // Google Play: a release note belongs to a track, and the server asks for it whenever anything of the release is staged.
        const t = await api.stageReleaseField(workspaceId, app.id, { field: 'track', value: track.trim() === '' ? 'production' : track.trim() });
        last = t.staged;
      }
      for (const locale of unsaved) {
        const text = (drafts[locale] ?? '').replace(/\r\n?/g, '\n').trim();
        try {
          const out = apple
            ? await api.stageText(workspaceId, app.id, { locale, field: 'release_notes', from: 'local', value: text })
            : await api.stageReleaseField(workspaceId, app.id, { field: 'release_notes', locale, value: text });
          last = out.staged;
        } catch (e) {
          failed.push(`${locale}: ${stagingError(e)}`);
        }
      }
      if (last) stagedStore.set(last);
      const ok = unsaved.length - failed.length;
      if (failed.length > 0) problem = failed.slice(0, 3).join(' ');
      if (ok > 0) {
        done = `Staged the notes of ${ok} ${ok === 1 ? 'language' : 'languages'}. Nothing was sent to the store.`;
        const keep: Record<string, string> = {};
        for (const k of Object.keys(drafts)) if (unsaved.indexOf(k) < 0 || failed.some((f) => f.startsWith(`${k}:`))) keep[k] = drafts[k] as string;
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

<div class="stack">
  <p class="lead">
    What is new, per language. Staging saves the text in this tool; it reaches the store when you push the draft in the last step.
    <InfoTip label="About the notes" text="Apple allows 4000 characters, Google Play 500. An empty text cannot be staged here; this tool does not clear a store field." />
  </p>

  {#if !apple && promote !== null && promoteNotes !== null}
    {@const line = promoteNotesLine(promoteNotes, trackLabel(promote.from).toLowerCase(), promote.codes)}
    <Alert tone={line.tone}>{line.text}</Alert>
  {/if}

  {#if apple}
    <section class="tf" aria-label="TestFlight notes">
      <h3>TestFlight notes</h3>
      {#if candidates === null}
        <p class="muted small">The builds were not read yet. Choose the build in the first step.</p>
      {:else if builds.length === 0}
        <p class="muted small">No builds are listed, so there are no TestFlight notes to use.</p>
      {:else}
        <ul class="tfs">
          {#each chosenFirst.slice(0, 6) as b (b.id)}
            {@const label = b.buildNumber !== null ? `Build ${b.buildNumber}` : 'This build'}
            <li>
              <span class="small">{testFlightLine(b.testNotes, label)}{b.id === chosenBuildId ? ' (chosen)' : ''}</span>
              {#if hasTestNotes(b.testNotes)}
                <Button size="sm" disabled={!mayEdit} onclick={() => useTestFlight(b)}>Use TestFlight notes</Button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if withNotes.length === 0}<p class="muted small">None of the listed builds has TestFlight notes that could be read.</p>{/if}
        {#if tfNote}<p class="small" role="status">{tfNote}</p>{/if}
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
        <Button size="sm" aria-expanded={menuFor === row.locale} disabled={!mayEdit} onclick={() => openMenu(row.locale)}>Reuse earlier notes</Button>
        {#if locales.length > 1}<Button size="sm" aria-expanded={copyFor === row.locale} disabled={!mayEdit || row.draft.trim() === ''} onclick={() => openCopy(row.locale)}>Copy to other languages</Button>{/if}
      </div>
      <label class="visually-hidden" for="{id}-text">What is new, {row.locale}</label>
      <textarea id="{id}-text" rows="5" value={row.draft} disabled={!mayEdit || staging} oninput={(e) => setDraft(row.locale, e.currentTarget.value)}></textarea>
      {#if row.over}<p class="small bad">Over the limit by {row.chars - row.limit} characters. The store would refuse it.</p>{/if}

      {#if menuFor === row.locale}
        <div class="panel" role="region" aria-label="Earlier notes, {row.locale}">
          {#if historyState === 'loading'}
            <div role="status" aria-label="Reading earlier notes"><Skeleton width="60%" height="14px" /></div>
          {:else if historyState === 'error'}
            <p class="small bad">{historyMessage}</p>
          {:else if history}
            {@const options = reuseOptions(history, row.locale, app.platform, row.draft, dateText)}
            {@const line = historyStoreLine(history.store)}
            {#if line}<p class="muted small">{line}</p>{/if}
            {#if options.length === 0}
              <p class="muted small">No earlier notes were found in {row.locale}.</p>
            {:else}
              <ul class="options">
                {#each options as o (o.text)}
                  <li>
                    <button type="button" class="option" disabled={o.same} onclick={() => reuse(row.locale, o.text)}>
                      <span class="pv">{o.preview || 'Empty text'}</span>
                      {#each o.uses as u (u)}<span class="use">{u}</span>{/each}
                      {#if o.usesMore > 0}<span class="use">and {o.usesMore} more</span>{/if}
                      {#if o.same}<span class="use">The editor has this text already.</span>{/if}
                      {#if o.overLimit !== null}<span class="use bad">{o.overLimit} characters: over the limit for this store.</span>{/if}
                      {#if o.truncated}<span class="use">The store text was cut when it was read.</span>{/if}
                    </button>
                  </li>
                {/each}
              </ul>
              <p class="muted small">Choosing one puts the text in the editor. It replaces what is there. Nothing is staged until you stage the notes.</p>
            {/if}
          {/if}
        </div>
      {/if}

      {#if copyFor === row.locale}
        <div class="panel" role="region" aria-label="Copy {row.locale} to other languages">
          <fieldset class="targets">
            <legend class="small">Copy the {row.locale} text to</legend>
            {#each locales.filter((l) => l !== row.locale) as target (target)}
              <label class="check"><input type="checkbox" checked={copyTargets.indexOf(target) >= 0} onchange={(e) => (copyTargets = e.currentTarget.checked ? [...copyTargets, target] : copyTargets.filter((t) => t !== target))} /> <span>{target}</span></label>
            {/each}
          </fieldset>
          {#if copyOverwrites > 0}<p class="small bad">This replaces {copyOverwrites} {copyOverwrites === 1 ? 'text' : 'texts'} that {copyOverwrites === 1 ? 'is' : 'are'} not empty.</p>{/if}
          <div class="row">
            <Button size="sm" variant="primary" disabled={copyTargets.length === 0} onclick={() => doCopy(row.locale)}>Copy</Button>
            <Button size="sm" variant="ghost" onclick={() => (copyFor = '')}>Cancel</Button>
          </div>
        </div>
      {/if}
    </section>
  {/each}

  {#if rows.length === 0}
    <p class="muted">No language is known for this release yet. Add one below.</p>
  {/if}

  {#if mayEdit}
    <div class="add">
      <label for="{uid}-add">Add a language</label>
      <input id="{uid}-add" type="text" placeholder="For example de-DE" autocomplete="off" spellcheck="false" bind:value={newLocale} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLocale(); } }} />
      <Button size="sm" disabled={!isNoteLocale(newLocale) || locales.indexOf(newLocale.trim().replace(/_/g, '-')) >= 0} onclick={addLocale}>Add</Button>
    </div>

    <div class="row step-actions">
      <Button variant="primary" loading={staging} disabled={unsaved.length === 0 || staging || overs > 0} onclick={stageNotes}>
        Stage the notes{unsaved.length > 0 ? ` (${unsaved.length})` : ''}
      </Button>
      {#if overs > 0}<span class="small bad">Shorten the texts over the limit first.</span>{:else if unsaved.length === 0}<span class="muted small">Nothing to stage: every language is as staged or as in the store.</span>{/if}
    </div>
  {:else}
    <p class="muted small">Staging needs the member role or above.</p>
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
