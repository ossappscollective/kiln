<!--
  AdsTab: the Ads tab of Insights (`?view=ads`, docs/adr/0058-apple-ads.md), READ ONLY: what your Apple Ads campaigns spent and what people searched
  before they tapped an ad. Same hierarchy as every page (docs/ux-ia.md 0e): the header holds scope and Sync (this page syncs the Apple Ads reports),
  then the range bar and [the section rail | the content]. Sections (`?section=`): Overview (the default), Campaigns, Search terms, Keywords and
  Account (the link and what the last read said). An app that is not linked to an ad account gets one setup card instead of the sections.
  Apple Ads exists for App Store records only; with several in scope a small switch picks the record. Reads stored data only.
  Props: api, workspaceId, role, members (records in scope), now, refreshKey (changes when a sync ended).
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { addDays } from '@kiln/core';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { type AdsLinkView, type AdsState, ADS_SECTIONS, adsApps, adsCredentials, adsErrorText, adsSectionKeys, warningText, withAdsSection } from '../../lib/ads/ads.ts';
  import { type RangeChoice, parseRange, resolveRange, withRange } from '../../lib/analytics/analytics.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { type RailGroup, resolveRailSection } from '../../lib/section-rail.ts';
  import type { AppSummary, CredentialSummary } from '../../lib/types.ts';
  import RangeControl from '../analytics/RangeControl.svelte';
  import UpdatedLine from '../app/UpdatedLine.svelte';
  import Alert from '../ui/Alert.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';
  import SectionRail from '../ui/SectionRail.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import AdsCampaignsSection from './AdsCampaignsSection.svelte';
  import AdsLinkForm from './AdsLinkForm.svelte';
  import AdsOverviewSection from './AdsOverviewSection.svelte';
  import AdsTermsSection from './AdsTermsSection.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    now,
    refreshKey = 0,
  }: { api: Api; workspaceId: string; role: Role; members: AppSummary[]; now: number; refreshKey?: number | undefined } = $props();

  const apps = $derived(adsApps(members));
  let pickedId = $state('');
  const app = $derived(apps.find((a) => a.id === pickedId) ?? apps[0] ?? null);

  let adsInfo = $state<AdsState | null>(null);
  let credentials = $state<CredentialSummary[] | null>(null);
  let error = $state('');
  let loading = $state(true);
  let generation = 0;

  $effect(() => {
    void refreshKey;
    const space = workspaceId;
    const id = app?.id;
    const mine = ++generation;
    if (!id) {
      loading = false;
      return;
    }
    loading = true;
    const reads: Promise<unknown>[] = [
      api
        .adsState(space, id)
        .then((r) => {
          if (mine === generation) {
            adsInfo = r;
            error = '';
          }
        })
        .catch((e: unknown) => {
          if (mine === generation) error = adsErrorText(e);
        }),
    ];
    if (can(role, 'credentials.read')) {
      reads.push(
        api
          .credentials(space)
          .then((r) => {
            if (mine === generation) credentials = r.credentials;
          })
          .catch(() => {}),
      );
    }
    void Promise.all(reads).then(() => {
      if (mine === generation) loading = false;
    });
  });

  const choice = $derived(parseRange(address.hash));
  const range = $derived(resolveRange(choice, now));
  /** The server reads a year at most; a longer range shows the last year (the range bar still says what was asked). */
  const window = $derived(range.days > 366 ? { from: addDays(range.to, -365), to: range.to } : { from: range.from, to: range.to });
  const setRange = (next: RangeChoice) => replaceHash(withRange(location.hash, next));

  const groups = $derived<RailGroup[]>([
    {
      id: 'ads',
      label: t('ads:rail.group'),
      entries: ADS_SECTIONS.map((id) => ({ id, label: t(adsSectionKeys[id]) })),
    },
  ]);
  const part = $derived(resolveRailSection(address.hash, [...ADS_SECTIONS]));
  const link = $derived(adsInfo?.link ?? null);
  const setLink = (next: AdsLinkView | null) => {
    if (adsInfo) adsInfo = { ...adsInfo, link: next, sync: next ? adsInfo.sync : null };
  };
  const warnings = $derived(adsInfo?.sync?.warnings ?? []);
  const hasCredential = $derived(adsCredentials(credentials).length > 0);
</script>

<div class="ads stack loose" data-testid="ads-tab">
  {#if app === null}
    <p class="muted">{t('ads:noApple')}</p>
  {:else}
    {#if apps.length > 1}
      <div class="row" role="group" aria-label={t('ads:pick')}>
        {#each apps as a (a.id)}
          <button type="button" class="pick" aria-pressed={a.id === app.id} onclick={() => (pickedId = a.id)}><PlatformBadge platform={a.platform} tinted /> {a.name}</button>
        {/each}
      </div>
    {/if}

    {#if error}
      <Alert tone="error">{error}</Alert>
    {:else if loading && adsInfo === null}
      <Skeleton height="6rem" />
    {:else if adsInfo && !adsInfo.supported}
      <p class="muted">{t('ads:err.notSupported')}</p>
    {:else if adsInfo && link === null}
      <section class="stack setup" aria-labelledby="ads-setup-title" data-testid="ads-setup">
        <h2 id="ads-setup-title" class="text-lg">{t('ads:setup.title')}</h2>
        <p>{t('ads:setup.lead')}</p>
        <ol class="steps">
          <li>{t('ads:setup.step1')}</li>
          <li>{t('ads:setup.step2')}</li>
          <li>{t('ads:setup.step3')}</li>
        </ol>
        {#if !hasCredential && credentials !== null && can(role, 'credentials.write')}
          <p class="muted">{t('ads:setup.needsCredential')}</p>
        {/if}
        <AdsLinkForm {api} {workspaceId} {role} {app} {link} {credentials} {now} onchanged={setLink} />
      </section>
    {:else if adsInfo && link}
      <div class="filters no-print">
        <RangeControl {choice} {range} {now} onchange={setRange} />
        <span class="spacer"></span>
        <UpdatedLine {api} {workspaceId} {role} apps={[app]} kinds={['ads']} {refreshKey} />
      </div>

      {#if adsInfo.sync?.lastError}
        <Alert tone="warn">{adsInfo.sync.lastError}</Alert>
      {/if}
      {#if range.days > 366}<p class="muted text-sm">{t('ads:rangeClamped')}</p>{/if}

      <SectionRail {groups} value={part} hrefFor={(id) => withAdsSection(address.hash, id)} label={t('ads:rail.label')}>
        {#if part === 'campaigns'}
          <AdsCampaignsSection {api} {workspaceId} appId={app.id} {window} {refreshKey} />
        {:else if part === 'terms'}
          <AdsTermsSection {api} {workspaceId} {role} appId={app.id} kind="term" {window} {refreshKey} />
        {:else if part === 'keywords'}
          <AdsTermsSection {api} {workspaceId} {role} appId={app.id} kind="keyword" {window} {refreshKey} />
        {:else if part === 'account'}
          <div class="stack">
            <AdsLinkForm {api} {workspaceId} {role} {app} {link} {credentials} {now} onchanged={setLink} />
            {#if adsInfo.sync}
              <p class="muted text-sm" data-testid="ads-sync-facts">
                {t('ads:account.synced', { campaigns: adsInfo.sync.campaigns, from: adsInfo.sync.rangeStart ?? t('ads:none'), to: adsInfo.sync.rangeEnd ?? t('ads:none') })}
                {#if !adsInfo.sync.complete} {t('ads:account.partial')}{/if}
              </p>
            {:else}
              <p class="muted text-sm">{t('ads:account.neverSynced')}</p>
            {/if}
            {#if warnings.length > 0}
              <ul class="warnings">
                {#each warnings as w (w)}<li>{warningText(w)}</li>{/each}
              </ul>
            {/if}
          </div>
        {:else}
          <AdsOverviewSection {api} {workspaceId} appId={app.id} {window} {refreshKey} />
        {/if}
      </SectionRail>
    {/if}
  {/if}
</div>

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
  }

  .spacer {
    flex: 1;
  }

  .pick {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    padding: var(--space-1) var(--space-3);
    font: inherit;
    color: var(--text);
    cursor: pointer;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
  }

  .pick[aria-pressed='true'] {
    background: var(--surface-active);
  }

  .setup {
    max-width: 44rem;
  }

  .steps {
    padding-left: var(--space-5);
    margin: 0;
  }

  .warnings {
    padding-left: var(--space-5);
    margin: 0;
    color: var(--warn-ink);
  }
</style>
