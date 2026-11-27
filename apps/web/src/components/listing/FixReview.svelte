<!--
  FixReview: the small review before one or more mechanical fixes of the listing checks are staged. Per fix: the field, the sentence that says what it does,
  the text before and after (a keyword field as its terms, removed ones struck through; any other text as a word diff), and the counter against the limit.
  "Stage fix" stages through the server, which computes the fix again from its own values (a text that changed since is refused as stale) and puts it in the
  pending changes (the cart): nothing is written to a store and nothing is published without the cart's review. On success it closes and the cart pulses.
  Props: api, workspaceId, appId, fixes (the fixes of ONE app, each `kind: stage`), open (bindable), onstaged? (called after the staging, to read the screens again).
-->
<script lang="ts">
  import type { Fix } from '@kiln/core';
  import { type Api, ApiError } from '../../lib/api.ts';
  import { formatNumber } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { fixLabel, fixSummary, hashText, termMarks } from '../../lib/listing/fixes.ts';
  import { lengthOf } from '../../lib/listing/edit.ts';
  import { placementLabel } from '../../lib/ai/placement.ts';
  import { stagedStore } from '../../lib/app-state/pending-facade.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Modal from '../ui/Modal.svelte';
  import DiffText from './DiffText.svelte';

  let {
    api,
    workspaceId,
    appId,
    fixes,
    open = $bindable(false),
    onstaged,
  }: {
    api: Api;
    workspaceId: string;
    appId: string;
    fixes: Fix[];
    open?: boolean | undefined;
    onstaged?: (() => void | Promise<void>) | undefined;
  } = $props();

  let busy = $state(false);
  let problem = $state('');
  $effect(() => {
    if (open) problem = '';
  });

  const count = (fix: Fix, text: string) => `${formatNumber(lengthOf(text, fix.unit))}${fix.limit !== null ? ` / ${formatNumber(fix.limit)}` : ''}`;
  const unitName = (fix: Fix) => (fix.unit === 'bytes' ? t('listing:fix.bytes') : t('listing:fix.characters'));

  async function stage() {
    if (busy || fixes.length === 0) return;
    busy = true;
    problem = '';
    let done = 0;
    try {
      for (const fix of fixes) {
        const answer = await api.stageListingFix(workspaceId, appId, { locale: fix.locale, field: fix.field, fixId: fix.id, beforeHash: await hashText(fix.before) });
        stagedStore.set(answer.staged);
        done += 1;
      }
      toast.success(t('app:cart.added'));
      open = false;
    } catch (e) {
      problem = e instanceof ApiError ? e.message : t('listing:fix.failed');
      if (done > 0) problem = `${t('listing:fix.partial', { done, total: fixes.length })} ${problem}`;
    } finally {
      busy = false;
    }
    if (done > 0) await onstaged?.();
  }
</script>

<Modal bind:open size="md" dismissible={!busy} title={fixes.length === 1 ? t('listing:fix.reviewTitleOne') : t('listing:fix.reviewTitle', { count: fixes.length })} description={t('listing:fix.reviewDescription')}>
  <div class="stack loose" data-testid="fix-review">
    {#each fixes as fix (`${fix.locale}/${fix.field}/${fix.id}`)}
      {@const platformField = placementLabel(fix.field)}
      <section class="fix">
        <div class="head">
          <strong>{fixLabel(fix)}</strong>
          <span class="muted">{platformField} · {fix.locale}</span>
          <Badge tone={fix.risk === 'safe' ? 'ok' : 'warn'}>{fix.risk === 'safe' ? t('listing:fix.riskSafe') : t('listing:fix.riskReview')}</Badge>
        </div>
        <p class="muted">{fixSummary(fix)}</p>
        {#if fix.after !== null}
          <div class="pair">
            <div>
              <p class="label">{t('listing:fix.before')} <span class="num">{count(fix, fix.before)} {unitName(fix)}</span></p>
              <p class="value" lang={fix.locale}>
                {#if fix.field === 'keywords'}
                  {#each termMarks(fix.before, fix.removed) as m, i (i)}{#if i > 0},{/if}{#if m.removed}<del><span class="visually-hidden">{t('listing:fix.removedTerm')}</span>{m.term}</del>{:else}{m.term}{/if}{/each}
                {:else}
                  <DiffText from={fix.before} to={fix.after} side="from" fromName={t('listing:fix.before')} toName={t('listing:fix.after')} />
                {/if}
              </p>
            </div>
            <div>
              <p class="label">{t('listing:fix.after')} <span class="num">{count(fix, fix.after)} {unitName(fix)}</span></p>
              <p class="value" lang={fix.locale}>
                {#if fix.field === 'keywords'}{fix.after}{:else}<DiffText from={fix.before} to={fix.after} side="to" fromName={t('listing:fix.before')} toName={t('listing:fix.after')} />{/if}
              </p>
            </div>
          </div>
          {#if fix.removed.length > 0}
            <p class="removed">{t('listing:fix.removedList', { terms: fix.removed.join(', ') })}</p>
          {/if}
        {/if}
      </section>
    {/each}
    <p class="muted note">{t('listing:fix.notPublished')}</p>
    {#if problem}<Alert tone="error">{problem}</Alert>{/if}
  </div>

  {#snippet footer()}
    <Button variant="ghost" disabled={busy} onclick={() => (open = false)}>{t('common:action.cancel')}</Button>
    <Button variant="primary" icon="layers" loading={busy} disabled={busy || fixes.length === 0} onclick={() => void stage()}>
      {fixes.length === 1 ? t('listing:fix.stage') : t('listing:fix.stageMany', { count: fixes.length })}
    </Button>
  {/snippet}
</Modal>

<style>
  .fix {
    padding: var(--space-3);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .fix p {
    margin: var(--space-1) 0 0;
  }

  .pair {
    display: grid;
    gap: var(--space-3);
    margin-top: var(--space-2);
  }

  @media (min-width: 40rem) {
    .pair {
      grid-template-columns: 1fr 1fr;
    }
  }

  .label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .value {
    padding: var(--space-2) var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    background: var(--surface-sunken);
    border-radius: var(--radius-md);
  }

  del {
    color: var(--bad-ink);
    text-decoration: line-through;
    background: var(--bad-bg);
  }

  .removed,
  .note {
    font-size: var(--text-sm);
  }
</style>
