<!--
  EmptyLocaleFix: a language the store holds with required texts left empty (App Store Connect creates a localization with nothing in it
  when a language is added, and a submit stops on "Description is empty in fr-FR"), in the locale panel of Store listing. It says which
  texts are empty and offers the one-click fixes: "Copy from en-US" and "Translate from en-US" (the translation provider of Settings, or
  the AI provider; links and addresses are copied, never translated). Both only STAGE text (pending changes): nothing is pushed or submitted
  from here. Removing the language is advice only: this tool cannot delete a localization. Says nothing when nothing is empty.
  Props: api, workspaceId, role, app, row (the locale of the grid), platform, locked? (the version is locked: no actions).
-->
<script lang="ts">
  import { can, type Role } from '@kiln/core';
  import { untrack } from 'svelte';
  import { aiStore } from '../../lib/ai/store.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { emptyFieldWord, emptyLine, fillPlan, pickSource, stillEmpty } from '../../lib/listing/empty-locale.ts';
  import type { MatrixRow } from '../../lib/listing/matrix.ts';
  import { type EngineState, type TranslateEngine, aiEngine, machineEngine, translateErrorMessage } from '../../lib/release-notes-translate.ts';
  import { loadTranslationConfig, type TranslationConfig } from '../../lib/settings.ts';
  import { canStage, stagingError } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';

  let { api, workspaceId, role, app, row, locked = false, allRows }: { api: Api; workspaceId: string; role: Role; app: AppSummary; row: MatrixRow; locked?: boolean | undefined; allRows: readonly MatrixRow[] } = $props();

  let busy = $state<'' | 'copy' | TranslateEngine>('');
  let problem = $state('');
  let machineConfig = $state<TranslationConfig | null | undefined>(undefined);

  const mayStage = $derived(!locked && canStage(role));

  $effect(() => {
    const key = workspaceId;
    untrack(() => {
      if (key === '' || !mayStage) return;
      if (can(role, 'settings.read')) void loadTranslationConfig(api, workspaceId).then((c) => (machineConfig = c));
      else machineConfig = null;
      if (can(role, 'ai.use')) void aiStore.loadConfig(api, workspaceId);
    });
  });

  const machine = $derived<EngineState>(machineEngine({ role, config: machineConfig }));
  const ai = $derived<EngineState>(aiEngine({ role, config: aiStore.config(workspaceId), failed: aiStore.configFailed(workspaceId) }));

  /** The empty texts the store reports, less what is staged for them already. */
  const empty = $derived.by(() => {
    const staged: Record<string, string> = {};
    for (const item of stagedStore.view(app.id)?.text ?? []) if (item.locale === row.locale) staged[item.field] = item.value;
    return stillEmpty(row.empty[app.platform] ?? [], staged);
  });
  const source = $derived(empty.length === 0 ? null : pickSource(allRows, app.platform, row.locale, empty));
  const plan = $derived(source === null ? null : fillPlan(source, empty));

  async function stageAll(items: { field: string; value: string }[], translated: boolean) {
    let last = null;
    for (const item of items) {
      const done = await api.stageText(workspaceId, app.id, { locale: row.locale, field: item.field, from: 'local', value: item.value });
      last = done.staged;
    }
    if (last !== null) stagedStore.set(last);
    const names = formatList(items.map((i) => emptyFieldWord(i.field)), { type: 'unit' });
    toast.success(translated ? t('listing:empty.translated', { locale: row.locale, fields: names }) : t('listing:empty.staged', { locale: row.locale, fields: names }));
  }

  async function copy() {
    if (plan === null || busy !== '') return;
    busy = 'copy';
    problem = '';
    try {
      await stageAll(plan.items, false);
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = '';
    }
  }

  async function translate(engine: TranslateEngine) {
    if (plan === null || busy !== '') return;
    busy = engine;
    problem = '';
    const out: { field: string; value: string }[] = [];
    const failed: string[] = [];
    try {
      for (const item of plan.items) {
        if (!item.translate) {
          out.push({ field: item.field, value: item.value });
          continue;
        }
        try {
          const result = await api.translateReleaseNotes(workspaceId, app.id, { engine, sourceLocale: plan.source, text: item.value, targetLocales: [row.locale] });
          const text = result.texts[row.locale];
          if (typeof text === 'string' && text.trim() !== '') out.push({ field: item.field, value: text });
          else failed.push(t('listing:empty.failed', { field: emptyFieldWord(item.field), message: result.failed[row.locale] ?? '' }));
        } catch (e) {
          failed.push(t('listing:empty.failed', { field: emptyFieldWord(item.field), message: translateErrorMessage(e) }));
        }
      }
      if (out.length > 0) await stageAll(out, true);
      if (failed.length > 0) problem = failed.join(' ');
    } catch (e) {
      problem = stagingError(e);
    } finally {
      busy = '';
    }
  }
</script>

{#if empty.length > 0}
  <section class="empty-fix" aria-label={emptyLine(row.locale, empty)} data-testid="empty-locale-fix">
    <Alert tone="warn" title={emptyLine(row.locale, empty)}>
      <p class="hint">{t('listing:empty.hint')}</p>
      {#if mayStage && plan !== null && plan.items.length > 0}
        <div class="actions">
          <Button size="sm" variant="primary" icon="layers" loading={busy === 'copy'} disabled={busy !== ''} title={t('listing:empty.copyTitle', { source: plan.source })} onclick={copy}>{t('listing:empty.copy', { source: plan.source })}</Button>
          {#if machine.visible}
            <Button size="sm" loading={busy === 'machine'} disabled={!machine.enabled || busy !== ''} title={machine.enabled ? machine.sends : (machine.reason ?? '')} onclick={() => translate('machine')}>{t('listing:empty.translate', { source: plan.source })}</Button>
          {/if}
          {#if ai.visible}
            <Button size="sm" loading={busy === 'ai'} disabled={!ai.enabled || busy !== ''} title={ai.enabled ? ai.sends : (ai.reason ?? '')} onclick={() => translate('ai')}>{t('listing:empty.translateAi', { source: plan.source })}</Button>
          {/if}
        </div>
        {#if plan.without.length > 0}
          <p class="muted small">{t('listing:empty.without', { source: plan.source, fields: formatList(plan.without.map(emptyFieldWord), { type: 'unit' }) })}</p>
        {/if}
      {:else if mayStage}
        <p class="muted small">{t('listing:empty.noSource')}</p>
      {/if}
      {#if problem !== ''}<p class="problem" role="alert">{problem}</p>{/if}
      <p class="muted small">{t('listing:empty.removeAdvice')}</p>
    </Alert>
  </section>
{/if}

<style>
  .empty-fix {
    margin-bottom: var(--space-3, 0.75rem);
  }
  .hint {
    margin: 0 0 0.5rem;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  .small {
    margin: 0.25rem 0 0;
  }
  .problem {
    margin: 0.5rem 0 0;
    color: var(--danger, #b42318);
  }
</style>
