<!--
  SuggestButton: the quiet entry point of an AI suggestion: a small ghost button with a sparkle icon. It is drawn only when AI assistance
  is on for this workspace and the role may use it and accept what it makes (otherwise nothing is drawn, so a screen without AI looks
  as before); when AI is on but not ready, or the monthly limit is used up, it is drawn disabled with the reason beside it.
  Before the first run of a task in a session it shows, in a small popover, what is sent and what never is, and who receives it, and
  asks to go on ("Don't ask again for this task" is kept in localStorage; a failure to keep it just asks again). A run only makes a
  suggestion: it changes nothing, and nothing here sends anything to a store.
  Props: api, workspaceId, role, kind (what the task proposes, which decides the right needed), taskId, label (visible text), hiddenLabel?
  (extra words for screen readers), preview? (the options of the run: given, the popover offers "Show exactly what will be sent", which reads
  the data of this run from our own database and shows it; nothing is sent to a provider by that), onrun (does the run; may throw, the error is shown as a fixed sentence), disabledReason? (a reason
  the screen has that makes it unavailable now), align ('start' | 'end': which edge the popover lines up with).
-->
<script lang="ts">
  import { type AiProposalKind, type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { floating } from '../../lib/floating.ts';
  import { type AiPreview, type AiRunBody, type AiTaskView, aiErrorMessage, disclosureGate, providerSentence, suggestAvailability } from '../../lib/ai/ai.ts';
  import { previewFacts, previewText } from '../../lib/ai/insights.ts';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';

  let {
    api,
    workspaceId,
    role,
    kind,
    taskId,
    label,
    hiddenLabel = '',
    onrun,
    disabledReason = null,
    align = 'start',
    preview = null,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    kind: AiProposalKind;
    taskId: string;
    label: string;
    hiddenLabel?: string | undefined;
    onrun: () => Promise<void>;
    disabledReason?: string | null | undefined;
    align?: 'start' | 'end' | undefined;
    preview?: AiRunBody | null | undefined;
  } = $props();

  const uid = $props.id();

  let running = $state(false);
  let asking = $state(false);
  let info = $state<AiTaskView | null>(null);
  let providerId = $state<string | null>(null);
  let remember = $state(false);
  let root = $state<HTMLElement | null>(null);
  let confirmButton = $state<HTMLButtonElement | null>(null);
  let shown = $state<AiPreview | null>(null);
  let showing = $state(false);
  let previewProblem = $state('');

  const config = $derived(aiStore.config(workspaceId));
  const avail = $derived(suggestAvailability({ role, config, kind }));
  const tasks = $derived(aiStore.tasks(workspaceId));
  const reason = $derived(disabledReason ?? avail.reason);
  const enabled = $derived(avail.enabled && !disabledReason);

  $effect(() => {
    if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
  });

  // A click outside the popover closes it, like the info popovers.
  $effect(() => {
    if (!asking) return;
    const away = (event: PointerEvent) => {
      if (root && event.target instanceof Node && !root.contains(event.target)) asking = false;
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  });

  async function go() {
    running = true;
    try {
      await onrun();
      // Near a monthly limit the run answered with a warning: said once, quietly. Runs still work until the limit.
      const warning = aiStore.takeWarning(workspaceId);
      if (warning) toast.info(warning.message);
    } catch (e) {
      toast.error(aiErrorMessage(e));
    } finally {
      running = false;
    }
  }

  async function start() {
    if (running || !enabled) return;
    running = true;
    let list: Awaited<ReturnType<typeof aiStore.loadTasks>>;
    try {
      list = await aiStore.loadTasks(api, workspaceId);
    } finally {
      running = false;
    }
    const found = list?.tasks.find((task) => task.id === taskId) ?? null;
    if (found === null || found.status !== 'ready') {
      // Without the list of what is sent, nothing is sent: the person could not have been told.
      toast.error(t('ai:suggest.readFailed'));
      return;
    }
    providerId = list?.provider?.id ?? config?.settings.provider ?? null;
    if (disclosureGate.needs(found, providerId)) {
      info = found;
      remember = false;
      shown = null;
      previewProblem = '';
      asking = true;
      await tick();
      confirmButton?.focus();
      return;
    }
    await go();
  }

  function confirm() {
    if (info === null) return;
    disclosureGate.confirm(info, providerId, remember);
    asking = false;
    void go();
  }

  function cancel() {
    asking = false;
  }

  /** Reads what this run would send (stored data only) so the person can see it before saying yes. */
  async function showPreview() {
    if (preview === null || showing || info === null) return;
    showing = true;
    previewProblem = '';
    try {
      shown = (await api.previewAiTask(workspaceId, info.id, preview)).preview;
    } catch (e) {
      shown = null;
      previewProblem = aiErrorMessage(e, t('ai:suggest.previewFailed'));
    } finally {
      showing = false;
    }
  }
</script>

{#if avail.visible}
  <span
    class="suggest"
    bind:this={root}
    role="presentation"
    onkeydown={(e) => {
      if (e.key === 'Escape' && asking) {
        e.stopPropagation();
        cancel();
      }
    }}
  >
    <Button variant="ghost" size="sm" icon="sparkles" loading={running} disabled={!enabled} aria-haspopup="dialog" aria-expanded={asking} onclick={() => void start()}>
      {label}{#if hiddenLabel}<span class="visually-hidden"> {hiddenLabel}</span>{/if}
    </Button>
    {#if !enabled && reason}
      <InfoTip label={t('ai:suggest.whyUnavailable')} icon="info" text={reason} align={align} />
    {/if}
    <span class="visually-hidden" role="status">{running ? t('ai:suggest.asking') : ''}</span>

    {#if asking && info}
      <div class="pop" use:floating={{ anchor: root ?? null, align }} role="dialog" aria-labelledby="{uid}-title" aria-describedby="{uid}-who">
        <h4 id="{uid}-title">{t('ai:suggest.whatIsSent')}</h4>
        <p class="who" id="{uid}-who">{providerSentence(tasks?.provider ?? null)}</p>
        {#if tasks?.provider?.privacy}<p class="hint">{tasks.provider.privacy}</p>{/if}
        <ul class="plain">
          {#each info.disclosure.sends as line (line)}<li>{line}</li>{/each}
        </ul>
        <h4>{t('ai:suggest.neverSent')}</h4>
        <ul class="plain">
          {#each info.disclosure.neverSends as line (line)}<li>{line}</li>{/each}
        </ul>
        {#if preview !== null}
          <div class="preview">
            <Button size="sm" variant="ghost" icon="eye" loading={showing} disabled={showing} onclick={() => void showPreview()}>{t('ai:suggest.showExactly')}</Button>
            {#if previewProblem}<p class="hint" role="alert">{previewProblem}</p>{/if}
            {#if shown}
              {@const view = previewText(shown.input)}
              <p class="hint">{previewFacts(shown)}</p>
              <textarea class="sent" readonly rows="8" aria-label={t('ai:suggest.dataLabel')} value={view.text}></textarea>
              {#if view.cut}<p class="hint">{t('ai:suggest.viewCut')}</p>{/if}
            {/if}
          </div>
        {/if}
        <label class="check">
          <input type="checkbox" bind:checked={remember} />
          {t('ai:suggest.dontAsk')}
        </label>
        <div class="row end">
          <Button size="sm" variant="ghost" onclick={cancel}>{t('ai:suggest.cancel')}</Button>
          <button type="button" class="primary sm" bind:this={confirmButton} onclick={confirm}>{t('ai:suggest.confirm')}</button>
        </div>
      </div>
    {/if}
  </span>
{/if}

<style>
  .suggest {
    position: relative;
    display: inline-flex;
    gap: var(--space-1);
    align-items: center;
  }

  .pop {
    z-index: var(--z-dropdown);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    width: min(26rem, calc(100vw - var(--space-8)));
    padding: var(--space-3) var(--space-4);
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--ink);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }

  h4 {
    margin: 0;
    font-size: var(--text-sm);
  }

  .who {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .hint {
    margin: 0;
  }

  .plain {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding-left: var(--space-4);
    margin: 0;
  }

  .check {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-weight: 400;
    cursor: pointer;
  }

  .end {
    justify-content: flex-end;
  }

  .preview {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-items: flex-start;
  }

  .sent {
    box-sizing: border-box;
    width: 100%;
    max-height: 14rem;
    padding: var(--space-2);
    margin: 0;
    overflow: auto;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    resize: vertical;
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }
</style>
