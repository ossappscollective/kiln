<!--
  ReleaseNotes: the release notes of one plan, one text box per locale, with a live character count
  against the store limit of the plan (the App Store 4000, Google Play 500; a plan for both
  platforms gets the smaller one). They are drafts in our own database: nothing is sent to a store.
  Props: api, workspaceId, plan (PlanDetail), canWrite, onplan (called with every updated plan).
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { SUGGESTED_LOCALES, checkLocale, limitNote, noteCounter, planErrorMessage } from '../../lib/release.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { PlanDetail } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  let {
    api,
    workspaceId,
    plan,
    canWrite,
    onplan,
  }: { api: Api; workspaceId: string; plan: PlanDetail; canWrite: boolean; onplan: (plan: PlanDetail) => void } = $props();

  const uid = $props.id();

  /** Text the person typed and has not saved, by locale. */
  let drafts = $state<Record<string, string | undefined>>({});
  let busy = $state<string | null>(null);
  let problem = $state('');
  let localeInput = $state('');
  let localeProblem = $state('');
  let confirming = $state<string | null>(null);

  const notes = $derived(plan.releaseNotes);
  const locales = $derived(notes.map((n) => n.locale));
  const unused = $derived(SUGGESTED_LOCALES.filter((l) => !locales.some((x) => x.toLowerCase() === l.toLowerCase())));
  const valueOf = (locale: string, saved: string) => drafts[locale] ?? saved;
  const dirty = (locale: string, saved: string) => drafts[locale] !== undefined && drafts[locale] !== saved;

  async function call(key: string, action: () => Promise<{ plan: PlanDetail }>): Promise<boolean> {
    if (busy) return false;
    busy = key;
    problem = '';
    try {
      onplan((await action()).plan);
      return true;
    } catch (e) {
      problem = planErrorMessage(e);
      return false;
    } finally {
      busy = null;
    }
  }

  async function save(locale: string, text: string) {
    if (await call(locale, () => api.setReleaseNotes(workspaceId, plan.appId, plan.id, locale, text))) {
      drafts[locale] = undefined;
      toast.success(`Saved the release notes for ${locale}. Nothing was sent to a store.`);
    }
  }

  async function addLocale(event: SubmitEvent) {
    event.preventDefault();
    const checked = checkLocale(localeInput, locales);
    if (!checked.ok) {
      localeProblem = checked.message;
      return;
    }
    localeProblem = '';
    if (await call('add', () => api.setReleaseNotes(workspaceId, plan.appId, plan.id, checked.locale, ''))) {
      localeInput = '';
      queueMicrotask(() => document.getElementById(`${uid}-text-${checked.locale}`)?.focus());
    }
  }

  async function remove(locale: string) {
    if (await call(locale, () => api.deleteReleaseNotes(workspaceId, plan.appId, plan.id, locale))) {
      drafts[locale] = undefined;
      confirming = null;
    }
  }

  const readiness = $derived(plan.readiness.notes);
</script>

<section class="card" aria-labelledby="{uid}-title">
  <div class="card-header">
    <div>
      <h2 id="{uid}-title">Release notes</h2>
      <p>
        {#if readiness.locales === 0}
          No locales yet.
        {:else}
          {readiness.filled} of {readiness.locales} {readiness.locales === 1 ? 'locale' : 'locales'} written.
        {/if}
        {limitNote(plan.platform)}
      </p>
    </div>
  </div>

  {#if problem}<Alert tone="error">{problem}</Alert>{/if}

  {#if notes.length === 0}
    <p class="muted empty">
      {canWrite ? 'Add a locale for each language this version ships in, then write the notes.' : 'No release notes have been written yet.'}
    </p>
  {/if}

  <div class="locales">
    {#each notes as note (note.locale)}
      {@const value = valueOf(note.locale, note.text)}
      {@const counter = noteCounter(value, plan.platform)}
      {@const textId = `${uid}-text-${note.locale}`}
      <div class="locale">
        <div class="locale-head">
          <label for={textId}><strong>{note.locale}</strong></label>
          {#if note.text.trim() === '' && !dirty(note.locale, note.text)}<span class="muted small">Not written yet</span>{/if}
          {#if dirty(note.locale, note.text)}<span class="muted small">Unsaved changes</span>{/if}
        </div>
        <textarea
          id={textId}
          rows="4"
          {value}
          readonly={!canWrite}
          aria-invalid={counter.over}
          aria-describedby="{textId}-count"
          oninput={(e) => (drafts[note.locale] = e.currentTarget.value)}
        ></textarea>
        <p id="{textId}-count" class="count" class:over={counter.over}>
          {#if counter.over}<Icon name="alert" size={14} />{/if}
          <span>{counter.label}</span>
        </p>
        {#if counter.over}
          <p class="field-error" role="status"><Icon name="alert" size={14} /> Too long for the store. Shorten it before saving.</p>
        {/if}
        {#if canWrite}
          <div class="row">
            <Button size="sm" variant="primary" loading={busy === note.locale} disabled={!dirty(note.locale, note.text) || counter.over || (busy !== null && busy !== note.locale)} onclick={() => save(note.locale, value)}>Save {note.locale}</Button>
            {#if dirty(note.locale, note.text)}
              <Button size="sm" variant="ghost" disabled={busy !== null} onclick={() => (drafts[note.locale] = undefined)}>Discard changes</Button>
            {/if}
            <span class="spacer"></span>
            {#if confirming === note.locale}
              <span class="muted small">Remove {note.locale} and its text?</span>
              <Button size="sm" variant="danger" loading={busy === note.locale} onclick={() => remove(note.locale)}>Yes, remove</Button>
              <Button size="sm" variant="ghost" onclick={() => (confirming = null)}>Cancel</Button>
            {:else}
              <Button size="sm" variant="ghost" icon="trash" disabled={busy !== null} onclick={() => (confirming = note.locale)}>Remove locale<span class="visually-hidden"> {note.locale}</span></Button>
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  {#if canWrite}
    <form class="add" onsubmit={addLocale}>
      <div class="field">
        <label for="{uid}-locale">Add a locale</label>
        <input id="{uid}-locale" list="{uid}-locales" bind:value={localeInput} maxlength="35" autocomplete="off" aria-invalid={localeProblem !== ''} aria-describedby="{uid}-locale-hint" placeholder="en-US" />
        <datalist id="{uid}-locales">
          {#each unused as locale (locale)}<option value={locale}></option>{/each}
        </datalist>
        {#if localeProblem}
          <p class="field-error" role="alert"><Icon name="alert" size={14} /> {localeProblem}</p>
        {/if}
        <p id="{uid}-locale-hint" class="hint">A locale code such as en-US, de or pt_BR, or default.</p>
      </div>
      <Button type="submit" icon="plus" loading={busy === 'add'} disabled={busy !== null && busy !== 'add'}>Add locale</Button>
    </form>
  {/if}
</section>

<style>
  .empty {
    margin: 0 0 var(--space-4);
  }

  .locales {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
    margin-bottom: var(--space-4);
  }

  .locale {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .locale-head {
    display: flex;
    gap: var(--space-3);
    align-items: baseline;
  }

  .small {
    font-size: var(--text-sm);
  }

  .count {
    display: flex;
    gap: var(--space-1);
    align-items: center;
    margin: 0;
    font-size: var(--text-xs);
    color: var(--muted);
  }

  .count.over {
    font-weight: var(--weight-semibold);
    color: var(--bad-ink);
  }

  .add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: flex-start;
  }

  .add .field {
    flex: 1 1 240px;
    margin: 0;
  }

  .add :global(button) {
    margin-top: var(--space-6);
  }
</style>
