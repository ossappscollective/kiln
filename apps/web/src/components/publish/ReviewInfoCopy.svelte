<!--
  ReviewInfoCopy: "Copy review information from 1.19.0", the repair for a version whose App Review Information is missing or blank
  (docs/api/review-information.md). Shown next to a blocker about it (`no_review_contact`, `no_review_demo_account`) in the submit
  checklist and in the publish plan. Two steps: the first click READS the store and says what would be copied as a MASKED line (the
  contact's initials, whether phone and email are there, whether a demo account is required) and never a name, number, address, password
  or note; the second click copies, once, with the preview's hash, inside `confirmed(...)` so a workspace that covers the action with a
  step-up asks for the person's confirmation. Only blank attributes are written, a filled value is never changed, attachments are not
  copied. The server decides; the button follows the app state's verdict for a store draft write.
  Needs the context of the screen (lib/review-repair-context.ts); without one it draws nothing.
  Props: from (the version string it can be copied from, from the blocker; null: the server finds it).
-->
<script lang="ts">
  import { can } from '@kiln/core';
  import { announcePublished } from '../../lib/app-page.ts';
  import { appStateStore } from '../../lib/app-state/app-state-store.svelte.ts';
  import { k, t } from '../../lib/i18n/t.ts';
  import {
    type ReviewCopyPreview,
    classifyReviewCopyFailure,
    copyLabel,
    summaryText,
  } from '../../lib/review-information.ts';
  import { reviewRepair } from '../../lib/review-repair-context.ts';
  import { confirmed } from '../../lib/step-up-prompt.svelte.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Button from '../ui/Button.svelte';

  let { from = null }: { from?: string | null | undefined } = $props();

  const repair = reviewRepair();
  const ctx = $derived(repair ? repair() : null);
  const mayCopy = $derived(ctx !== null && (ctx.role === null || can(ctx.role, 'store.push_draft')));
  const verdict = $derived(
    ctx !== null && ctx.role !== null
      ? appStateStore.verdict(ctx.workspaceId, ctx.role, ctx.app, 'create_version')
      : null,
  );

  /** Why there is nothing to copy: no earlier version has review information, or the draft already holds all of it. */
  const NOTHING = {
    no_source: k('release-store:review.copy.nothingNoSource'),
    complete: k('release-store:review.copy.nothingComplete'),
  } as const;

  let busy = $state(false);
  let preview = $state<ReviewCopyPreview | null>(null);
  let problem = $state('');
  let announcement = $state('');

  const look = async () => {
    if (!ctx || busy) return;
    busy = true;
    problem = '';
    try {
      // Reads the store. Not a write.
      preview = (await ctx.api.previewStoreReviewInformation(ctx.workspaceId, ctx.app.id)).preview;
      if (!preview.canCopy) {
        const outcome = preview.reviewInformation.outcome;
        const why = outcome === 'no_source' ? 'no_source' : 'complete';
        problem = t(NOTHING[why]);
        announcement = problem;
        preview = null;
      }
    } catch (e) {
      problem = classifyReviewCopyFailure(e).message;
      announcement = problem;
    } finally {
      busy = false;
    }
  };

  const copy = async () => {
    if (!ctx || !preview || preview.confirmHash === null || busy) return;
    const body = { confirmHash: preview.confirmHash };
    const workspaceId = ctx.workspaceId;
    const appId = ctx.app.id;
    busy = true;
    problem = '';
    try {
      // The only call that writes. Sent once per click, with the hash of the preview; never retried by this app.
      const done = await confirmed(
        (grant) => ctx.api.copyStoreReviewInformation(workspaceId, appId, body, grant),
        body.confirmHash,
      );
      const text = t('release-store:review.copy.done', {
        version: done.result.version.versionString ?? '',
        from: done.result.reviewInformation.from ?? '',
      });
      announcement = text;
      toast.success(text);
      preview = null;
      announcePublished(appId);
      ctx.onrepaired();
    } catch (e) {
      const failure = classifyReviewCopyFailure(e);
      problem = failure.message;
      announcement = failure.message;
      if (failure.kind === 'state_changed') preview = failure.next !== null && failure.next.canCopy ? failure.next : null;
    } finally {
      busy = false;
    }
  };
</script>

{#if ctx !== null && mayCopy}
  <div class="copy" data-testid="review-copy">
    {#if preview === null}
      <Button
        size="sm"
        loading={busy}
        disabled={verdict !== null && !verdict.enabled}
        title={verdict !== null && !verdict.enabled ? (verdict.reason ?? undefined) : undefined}
        onclick={() => void look()}
        data-testid="review-copy-look"
      >{copyLabel(from)}</Button>
    {:else}
      <p class="small" data-testid="review-copy-summary">
        {t('release-store:review.copy.from', { from: preview.reviewInformation.from ?? '', version: preview.version.versionString ?? '' })}
        {summaryText(preview.reviewInformation.summary)}
      </p>
      <p class="small muted">{t('release-store:review.copy.note')}</p>
      <div class="row">
        <Button size="sm" variant="primary" loading={busy} onclick={() => void copy()} data-testid="review-copy-confirm">{t('release-store:review.copy.confirm')}</Button>
        <Button size="sm" disabled={busy} onclick={() => (preview = null)}>{t('common:action.cancel')}</Button>
      </div>
    {/if}
    {#if problem !== ''}<p class="small bad" role="alert" data-testid="review-copy-problem">{problem}</p>{/if}
    <p class="visually-hidden" role="status">{announcement}</p>
  </div>
{/if}

<style>
  .copy {
    display: grid;
    gap: var(--space-1);
    margin-top: var(--space-1);
  }

  .row {
    display: flex;
    gap: var(--space-2);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .muted {
    color: var(--muted);
  }

  .bad {
    color: var(--bad-ink);
  }
</style>
