<!--
  AsoFit: how well the stored live listing covers the tracked keywords, per locale: which of the searched fields have each keyword
  (name, subtitle, keyword field, description; on Android title, short and full description), the weak or missing high priority
  ones first, and for iOS the hidden keyword field against its 100 byte budget with the duplicates and wasted space.
  It reads the listing text the server stored (sync the app to refresh it); it never reads a store. Which fields each store
  searches is unverified; the tip says so. A suggestion, not advice. Editing happens in the Listing tab.
  Props: api, workspaceId, members, keywords, version.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import {
    type AsoFitResponse,
    type AsoKeyword,
    asoErrorMessage,
    asoViewHref,
    fieldCell,
    fitColumns,
    fitFieldLabels,
    fitStatusInfo,
    keywordMeter,
    localesOf,
    priorityLabel,
  } from '../../lib/aso.ts';
  import { headerParams, withHeaderParams } from '../../lib/app-header.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StatChip from '../ui/StatChip.svelte';

  let {
    api,
    workspaceId,
    members,
    keywords,
    version,
    now,
  }: { api: Api; workspaceId: string; members: AppSummary[]; keywords: AsoKeyword[]; version: number; now: number } = $props();

  const uid = $props.id();
  const multi = $derived(members.length > 1);
  const allLocales = $derived(localesOf(keywords));
  /** The locale of the page header (?locale=) when this view has keywords for it, else '' (the most used). */
  const locale = $derived.by(() => {
    const wanted = headerParams(address.hash).locale;
    return wanted !== null && allLocales.includes(wanted) ? wanted : '';
  });
  const setLocale = (value: string) => replaceHash(withHeaderParams(location.hash, { locale: value === '' ? null : value }));
  let data = $state<Record<string, AsoFitResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;

  $effect(() => {
    void version;
    const list = members;
    const mine = ++generation;
    void (async () => {
      const next: Record<string, AsoFitResponse | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          try {
            next[m.id] = await api.asoFit(workspaceId, m.id);
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, 'Could not load the fit.');
          }
        }),
      );
      if (mine !== generation) return;
      data = next;
      errors = bad;
      loading = false;
    })();
  });
</script>

<div class="fit stack">
  {#if allLocales.length > 1}
    <div class="row">
      <label for="{uid}-locale" class="muted">Locale</label>
      <select id="{uid}-locale" value={locale} onchange={(e) => setLocale(e.currentTarget.value)}>
        <option value="">Most used ({allLocales[0]})</option>
        {#each allLocales as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
  {/if}

  {#if loading}
    <Skeleton width="100%" height="140px" />
  {:else}
    {#each members as app (app.id)}
      {@const d = data[app.id]}
      {@const pick = d ? (d.locales.filter((l) => l.locale === (locale || allLocales[0]))[0] ?? d.locales[0]) : undefined}
      {@const fit = pick?.fit ?? null}
      <section class="stack" aria-label="{platformLabel(app.platform)} fit">
        <div class="row head">
          {#if multi}<h3 class="eyebrow">{platformLabel(app.platform)}</h3>{/if}
          {#if pick}<span class="muted">{pick.locale}{pick.listingLocale && pick.listingLocale !== pick.locale ? ` (listing text in ${pick.listingLocale})` : ''}</span>{/if}
          {#if d}
            <InfoTip label="What counts" align="start">
              <p class="tip">
                Compares the listing text stored on this server{d.readAt ? ` (read ${timeAgo(d.readAt, now)})` : ''} with your tracked keywords. Which fields each store searches is unverified:
                {d.indexedFields.join(', ')} are assumed.
              </p>
              {#if fit}<ul class="plain">{#each fit.assumptions as a (a)}<li>{a}</li>{/each}</ul>{/if}
            </InfoTip>
          {/if}
          <span class="spacer"></span>
          <Button size="sm" variant="link" icon="file-text" href={appAddress(app.id, 'listing', address.platform)}>Open the listing</Button>
        </div>

        {#if errors[app.id]}
          <Alert tone="error">{errors[app.id]}</Alert>
        {:else if d && d.locales.length === 0}
          <p class="none">No keywords tracked yet. <a href={asoViewHref(app.id, 'keywords', address.platform)}>Add keywords</a> to see how the listing covers them.</p>
        {:else if pick && !fit}
          <p class="none">No listing text is stored for {pick.locale}. Sync the app to read it, then come back.</p>
        {:else if fit && pick}
          <div class="row chips">
            <StatChip label="strong" value={fit.counts.strong} tone="ok" />
            <StatChip label="covered" value={fit.counts.covered} tone="ok" />
            <StatChip label="partial" value={fit.counts.partial + fit.counts.description_only} tone="warn" />
            <StatChip label="missing" value={fit.counts.missing} tone="bad" />
          </div>

          {#if fit.gaps.length > 0}
            <p class="weak">
              <span class="muted">Weak or missing:</span>
              {#each fit.gaps.slice(0, 8) as g (g.id)}
                <Badge tone={fitStatusInfo[g.status].tone}>{g.term}{g.priority >= 3 ? ' (high)' : ''}</Badge>
              {/each}
              {#if fit.gaps.length > 8}<span class="muted">and {fit.gaps.length - 8} more</span>{/if}
            </p>
          {/if}

          <div class="table-wrap">
            <table class="compact">
              <thead>
                <tr>
                  <th scope="col">Keyword</th>
                  <th scope="col">Fit</th>
                  {#each fitColumns[app.platform] as f (f)}<th scope="col" class="mid">{fitFieldLabels[f]}</th>{/each}
                </tr>
              </thead>
              <tbody>
                {#each fit.keywords as k (k.id)}
                  {@const status = fitStatusInfo[k.status]}
                  <tr>
                    <th scope="row" class="term">{k.term} {#if k.priority !== 2}<span class="muted prio">{priorityLabel(k.priority)}</span>{/if}</th>
                    <td><span title={status.hint}><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check-circle' : status.tone === 'bad' ? 'x-circle' : 'alert-triangle'}>{status.label}</Badge></span></td>
                    {#each fitColumns[app.platform] as f (f)}
                      {@const cell = fieldCell(k, f)}
                      <td class="mid" title={cell.title}>
                        {#if cell.mark === 'phrase'}
                          <span class="in"><Icon name="check" size={14} /><span class="visually-hidden">Phrase in this field</span>{cell.text}</span>
                        {:else if cell.mark === 'words'}
                          <span class="muted">{cell.text} words</span>
                        {:else}
                          <span class="muted"><span aria-hidden="true">–</span><span class="visually-hidden">Not in this field</span></span>
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          {#if fit.keywordField}
            {@const kf = fit.keywordField}
            {@const meter = keywordMeter(kf.bytes, kf.max)}
            {@const waste = kf.duplicates.length + kf.inTitleOrSubtitle.length}
            <div class="card kfield stack tight">
              <div class="row">
                <strong>Keyword field</strong>
                <InfoTip label="About the keyword field" text="The hidden App Store keyword field has a budget of 100 bytes (UNVERIFIED here: check it in App Store Connect). Entries whose words are already in the name or subtitle, and repeats, cost space for nothing." />
                <span class="spacer"></span>
                <span class="tabular {meter.tone}">{meter.text}</span>
              </div>
              <svg class="meter {meter.tone}" viewBox="0 0 100 6" preserveAspectRatio="none" role="meter" aria-valuemin="0" aria-valuemax={kf.max} aria-valuenow={kf.bytes} aria-label="Keyword field budget: {meter.text}">
                <rect x="0" y="0" width="100" height="6" class="track" />
                <rect x="0" y="0" width={meter.percent} height="6" class="fill" />
              </svg>
              {#if waste > 0 || kf.separatorBytes > 0}
                <Disclosure summary="Duplicates and waste ({waste} {waste === 1 ? 'entry' : 'entries'}, {kf.savedBytes} bytes to save)" stateKey="aso.kfield.{app.id}">
                  <ul class="plain waste">
                    {#if kf.duplicates.length > 0}<li>Repeated: {kf.duplicates.join(', ')}</li>{/if}
                    {#if kf.inTitleOrSubtitle.length > 0}<li>Already in the name or subtitle: {kf.inTitleOrSubtitle.join(', ')}</li>{/if}
                    {#if kf.separatorBytes > 0}<li>{kf.separatorBytes} bytes are spaces around commas.</li>{/if}
                  </ul>
                  <p class="row compact-row">
                    <span class="muted">Without them ({kf.compactedBytes} bytes):</span>
                    <code class="truncate">{kf.compacted}</code>
                    <CopyButton value={kf.compacted} iconOnly label="Copy the compacted keyword field" />
                  </p>
                </Disclosure>
              {/if}
            </div>
          {/if}
        {/if}
      </section>
    {/each}
  {/if}
</div>

<style>
  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .chips {
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .none {
    margin: var(--space-2) 0;
  }

  .weak {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-sm);
  }

  .term {
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .prio {
    font-size: var(--text-xs);
    font-weight: var(--weight-regular);
  }

  .mid {
    text-align: center;
  }

  .in {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    color: var(--ok-ink);
  }

  .tip {
    margin: 0 0 var(--space-2);
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .waste {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
  }

  .compact-row {
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    font-size: var(--text-sm);
  }

  .kfield .ok {
    color: var(--ok-ink);
  }

  .kfield .warn {
    color: var(--warn-ink);
  }

  .kfield .bad {
    color: var(--bad-ink);
  }

  .meter {
    display: block;
    width: 100%;
    height: 6px;
    border-radius: var(--radius-full);
  }

  .meter .track {
    fill: var(--surface-sunken);
  }

  .meter.ok .fill {
    fill: var(--ok);
  }

  .meter.warn .fill {
    fill: var(--warn);
  }

  .meter.bad .fill {
    fill: var(--bad);
  }
</style>
