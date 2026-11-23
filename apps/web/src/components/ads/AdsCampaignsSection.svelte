<!--
  AdsCampaignsSection: the campaigns of the Ads tab that promote this app: spend, taps, installs and the costs of the range, most spend first.
  One campaign is one row; many campaigns scroll the page, not the table (table.fit). Money is in the currency of the ad account only.
  Props: api, workspaceId, appId, window, refreshKey.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import { type AdsCampaignsResponse, adsErrorText, formatCount, formatMicros, formatRatio } from '../../lib/ads/ads.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

  let { api, workspaceId, appId, window, refreshKey = 0 }: { api: Api; workspaceId: string; appId: string; window: { from: string; to: string }; refreshKey?: number | undefined } = $props();

  let data = $state<AdsCampaignsResponse | null>(null);
  let error = $state('');
  let loading = $state(true);
  let generation = 0;

  $effect(() => {
    void refreshKey;
    const query = new URLSearchParams({ from: window.from, to: window.to }).toString();
    const mine = ++generation;
    loading = true;
    api
      .adsCampaigns(workspaceId, appId, query)
      .then((r) => {
        if (mine !== generation) return;
        data = r;
        error = '';
      })
      .catch((e: unknown) => {
        if (mine !== generation) return;
        error = adsErrorText(e);
      })
      .finally(() => {
        if (mine === generation) loading = false;
      });
  });
</script>

<div class="stack" data-testid="ads-campaigns">
  {#if error}
    <Alert tone="error">{error}</Alert>
  {:else if loading && data === null}
    <Skeleton height="6rem" />
  {:else if data}
    {#if data.campaigns.length === 0}
      <p class="muted" data-testid="ads-empty">{t('ads:campaigns.empty')}</p>
    {:else}
      <table class="fit compact" aria-label={t('ads:rail.campaigns')}>
        <colgroup><col style="width: 24%" /><col style="width: 12%" /><col style="width: 10%" /><col style="width: 9%" /><col style="width: 10%" /><col style="width: 11%" /><col style="width: 12%" /><col style="width: 12%" /></colgroup>
        <thead>
          <tr>
            <th scope="col">{t('ads:col.campaign')}</th>
            <th scope="col">{t('ads:col.spend')}</th>
            <th scope="col">{t('ads:col.impressions')}</th>
            <th scope="col">{t('ads:col.taps')}</th>
            <th scope="col">{t('ads:col.installs')}</th>
            <th scope="col">{t('ads:col.cpt')}</th>
            <th scope="col">{t('ads:col.cpi')}</th>
            <th scope="col">{t('ads:col.ttr')}</th>
          </tr>
        </thead>
        <tbody>
          {#each data.campaigns as c (c.campaignId)}
            <tr>
              <th scope="row" data-label={t('ads:col.campaign')}>
                {c.name}
                {#if c.status}<Badge tone="neutral">{c.status}</Badge>{/if}
                <span class="muted text-sm block">{t('ads:campaigns.days', { count: c.daysWithData })}</span>
              </th>
              <td data-label={t('ads:col.spend')}>{formatMicros(c.spendMicros, data.currency)}</td>
              <td data-label={t('ads:col.impressions')}>{formatCount(c.impressions)}</td>
              <td data-label={t('ads:col.taps')}>{formatCount(c.taps)}</td>
              <td data-label={t('ads:col.installs')}>{formatCount(c.installs)}</td>
              <td data-label={t('ads:col.cpt')}>{formatMicros(c.cptMicros, data.currency)}</td>
              <td data-label={t('ads:col.cpi')}>{formatMicros(c.cpiMicros, data.currency)}</td>
              <td data-label={t('ads:col.ttr')}>{formatRatio(c.ttr)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  {/if}
</div>

<style>
  .block {
    display: block;
  }
</style>
