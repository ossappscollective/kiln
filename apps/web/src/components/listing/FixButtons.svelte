<!--
  FixButtons: what one finding of the listing checks offers, for one locale of one app. Exactly one of:
  - "Fix staged" with "Discard" (the staged text already settles the finding; discarding takes the staged item back),
  - "Fix" (a mechanical fix: opens the review with the before and after, "Stage fix" stages it in the pending changes),
  - "Shorten with AI" (only when AI is on: the existing suggestion, which a person accepts) and "Open the editor" (the counter shows the limit),
  - "Open the editor" for a required field left empty (nothing is invented),
  - "Cannot be fixed automatically".
  Off, with its reason in words, for a locked version, a role that may not stage and a field a draft push cannot write. Nothing here publishes.
  Props: api, workspaceId, role, app, locale (the `LocaleFixes` of the locale), issue ({ id, code, field }), resolved (the staged text settles it), locked, onchanged.
-->
<script lang="ts">
  import { can, type CheckCode, type Role } from '@kiln/core';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { fieldInfo } from '../../lib/listing/edit.ts';
  import { cannotFix, fixBlockedReason, fixForIssue, fixLabel, type LocaleFixes, stagedItemOf } from '../../lib/listing/fixes.ts';
  import { placementLabel } from '../../lib/ai/placement.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import ImproveField from '../ai/ImproveField.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import FieldEditor from './FieldEditor.svelte';
  import FixReview from './FixReview.svelte';

  let {
    api,
    workspaceId,
    role,
    app,
    locale,
    issue,
    resolved = false,
    locked = false,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    app: Pick<AppSummary, 'id' | 'platform'>;
    locale: LocaleFixes | undefined;
    issue: { id: string; code: CheckCode; field: string | null };
    resolved?: boolean | undefined;
    locked?: boolean | undefined;
    onchanged?: (() => void | Promise<void>) | undefined;
  } = $props();

  let reviewing = $state(false);
  let editing = $state(false);
  let discarding = $state(false);
  let problem = $state('');

  const canStage = $derived(can(role, 'changesets.write'));
  const stageFix = $derived(fixForIssue(locale, issue, 'stage'));
  const aiFix = $derived(fixForIssue(locale, issue, 'ai_shorten'));
  const editFix = $derived(fixForIssue(locale, issue, 'edit_field'));
  const stagedId = $derived(stagedItemOf(locale, issue.field));
  const target = $derived(stageFix ?? aiFix ?? editFix);
  const blocked = $derived(
    target === null || issue.field === null ? null : fixBlockedReason({ canStage, locked, stageable: target.stageable, platform: app.platform, field: issue.field }),
  );
  const info = $derived(issue.field === null ? null : fieldInfo(app.platform, issue.field));
  const editLabel = $derived(issue.field === null ? '' : t('listing:fix.openEditor', { field: placementLabel(issue.field) }));

  async function discard() {
    if (stagedId === null || discarding) return;
    discarding = true;
    problem = '';
    try {
      const done = await api.unstageItem(workspaceId, app.id, stagedId);
      stagedStore.set(done.staged);
      await onchanged?.();
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('listing:fix.failed');
    } finally {
      discarding = false;
    }
  }
</script>

{#if resolved}
  <div class="fixes" data-testid="fix-staged">
    <Badge tone="ok" icon="layers">{t('listing:fix.staged')}</Badge>
    {#if stagedId !== null && canStage && !locked}
      <Button variant="ghost" size="sm" loading={discarding} disabled={discarding} onclick={() => void discard()}>{t('listing:fix.discard')}</Button>
    {/if}
    {#if problem}<span class="muted hint">{problem}</span>{/if}
  </div>
{:else if target !== null && issue.field !== null}
  <div class="fixes" data-testid="fix-buttons">
    {#if stageFix !== null}
      <Button variant="secondary" size="sm" icon="zap" disabled={blocked !== null} title={blocked ?? undefined} onclick={() => (reviewing = true)}>{t('listing:fix.button')}: {fixLabel(stageFix)}</Button>
    {:else}
      {#if aiFix !== null && blocked === null}
        <ImproveField {api} {workspaceId} {role} {app} field={{ locale: locale?.locale ?? '', field: issue.field, label: info?.label ?? issue.field }} current={aiFix.before} buttonLabel={t('listing:fix.shortenAi')} onaccepted={() => onchanged?.()} />
      {/if}
      <Button variant="secondary" size="sm" icon="edit" disabled={locked || info === null} title={locked ? t('listing:fix.locked') : undefined} onclick={() => (editing = true)}>{editLabel}</Button>
    {/if}
    {#if blocked !== null}
      <span class="muted hint">{blocked}</span>
    {:else if stageFix === null && aiFix !== null}
      <span class="muted hint">{t('listing:fix.shortenHint')}</span>
    {:else if stageFix === null && editFix !== null}
      <span class="muted hint">{t('listing:fix.emptyHint')}</span>
    {/if}
  </div>
  {#if stageFix !== null}
    <FixReview {api} {workspaceId} appId={app.id} fixes={[stageFix]} bind:open={reviewing} onstaged={onchanged} />
  {/if}
  {#if editing && locale}
    <FieldEditor {api} {workspaceId} {role} appId={app.id} platform={app.platform} locale={locale.locale} field={issue.field} bind:open={editing} onstaged={onchanged} />
  {/if}
{:else if cannotFix(locale, issue)}
  <p class="muted hint" data-testid="fix-cannot">{t('listing:fix.cannot')}</p>
{/if}

<style>
  .fixes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin-top: var(--space-2);
  }

  .hint {
    margin: 0;
    font-size: var(--text-sm);
  }
</style>
