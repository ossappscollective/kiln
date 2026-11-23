<!--
  CompetitorCard: one followed competitor: its name, version, rating (and how many ratings), price and a line about
  the last change. "Compare" puts it in the side by side table; the change history (a diff list of what changed and
  when) is collapsed. Everything a competitor wrote (name, subtitle) is plain text.
  Props: competitor, history (or null while it loads), now, canWrite, comparing, ontoggle, onremove, showStore.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { type AsoCompetitor, type AsoCompetitorHistory, changeText, countText, lastChangeText, ratingText } from '../../lib/aso/aso.ts';
  import { agoText } from '../../lib/aso/ago.ts';
  import { formatDate } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import CompetitorChanges from './CompetitorChanges.svelte';

  let {
    competitor,
    history,
    now,
    canWrite,
    comparing,
    ontoggle,
    onremove,
    busy = false,
    api,
    workspaceId,
    onchecked,
  }: {
    competitor: AsoCompetitor;
    history: AsoCompetitorHistory | null;
    now: number;
    canWrite: boolean;
    comparing: boolean;
    ontoggle: () => void;
    onremove: () => void;
    busy?: boolean | undefined;
    api: Api;
    workspaceId: string;
    onchecked?: (() => void) | undefined;
  } = $props();

  const uid = $props.id();
  const latest = $derived(competitor.latest);
  const changes = $derived((history?.snapshots ?? []).filter((s) => s.changes !== null && s.changes.length > 0));
  let confirming = $state(false);
</script>

<article class="card competitor" aria-labelledby="{uid}-name">
  <header class="head">
    <h3 id="{uid}-name" class="name truncate" title={competitor.name}>{competitor.name}</h3>
    {#if competitor.state === 'not_found'}
      <Badge tone="warn" icon="alert-triangle">{t('aso:card.notInStore')}</Badge>
    {:else if competitor.state === 'unavailable'}
      <Badge tone="warn" icon="alert-triangle">{t('aso:card.unreadable')}</Badge>
      <InfoTip label={t('aso:card.whyLabel')} text={competitor.error ? t('aso:card.whyTextError', { error: competitor.error }) : t('aso:card.whyText')} />
    {/if}
  </header>
  {#if latest?.subtitle}<p class="sub muted truncate" title={latest.subtitle}>{latest.subtitle}</p>{/if}

  <dl class="facts">
    <div><dt>{t('aso:compare.version')}</dt><dd>{latest?.version ?? '–'}</dd></div>
    <div>
      <dt>{t('aso:compare.rating')}</dt>
      <dd>{ratingText(latest?.rating)} <span class="muted">({countText(latest?.ratingCount)})</span></dd>
    </div>
    <div><dt>{t('aso:compare.price')}</dt><dd>{latest?.price ?? '–'}</dd></div>
    <div class="wide"><dt>{t('aso:card.lastChange')}</dt><dd>{lastChangeText(history, competitor, now)}</dd></div>
  </dl>

  <div class="row foot">
    <label class="check">
      <input type="checkbox" checked={comparing} onchange={ontoggle} />
      {t('aso:card.compare')}
    </label>
    <span class="muted when">{competitor.lastCheckedAt ? t('aso:card.lookedAt', { ago: agoText(competitor.lastCheckedAt, now) }) : t('aso:card.notLookedAt')}</span>
    <span class="spacer"></span>
    {#if canWrite}
      {#if confirming}
        <span class="confirm">
          {t('aso:card.stopQuestion')}
          <Button size="sm" variant="danger" loading={busy} onclick={onremove}>{t('aso:card.remove')}</Button>
          <Button size="sm" variant="ghost" onclick={() => (confirming = false)}>{t('common:action.cancel')}</Button>
        </span>
      {:else}
        <Button size="sm" variant="ghost" iconOnly icon="trash" label={t('aso:card.stopFollowing', { name: competitor.name })} onclick={() => (confirming = true)} />
      {/if}
    {/if}
  </div>

  {#if changes.length > 0}
    <Disclosure summary={t('aso:card.history', { count: changes.length })} stateKey="aso.competitor.{competitor.id}">
      <ul class="history">
        {#each changes as snap (snap.id)}
          <li>
            <time class="muted" datetime={new Date(snap.checkedAt).toISOString()}>{formatDate(snap.checkedAt, { year: 'numeric', month: 'short', day: 'numeric' })}</time>
            <ul>
              {#each snap.changes ?? [] as c, i (i)}<li>{changeText(c)}</li>{/each}
            </ul>
          </li>
        {/each}
      </ul>
    </Disclosure>
  {/if}
  <CompetitorChanges {api} {workspaceId} appId={competitor.appId} {competitor} {canWrite} {now} {onchecked} />
</article>

<style>
  .competitor {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    font-size: 0.9375rem;
    min-width: 0;
  }

  .head {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .name {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-size: var(--text-lg);
  }

  .sub {
    margin: 0;
    font-size: 0.9375rem;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-2) var(--space-3);
    margin: 0;
  }

  .facts dt {
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    font-size: 0.9375rem;
    overflow-wrap: anywhere;
  }

  .wide {
    grid-column: 1 / -1;
  }

  .foot {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .check {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
  }

  .when {
    font-size: var(--text-sm);
  }

  .confirm {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    font-size: 0.9375rem;
  }

  .history,
  .history ul {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .history > li {
    display: grid;
    grid-template-columns: 7rem minmax(0, 1fr);
    gap: var(--space-2);
    padding: var(--space-1) 0;
    border-top: 1px solid var(--line);
  }

  .history > li:first-child {
    border-top: 0;
  }
</style>
