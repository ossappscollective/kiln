<!--
  AsoGaps: terms the competitors you follow use in their names, subtitles or descriptions that your own listing does not
  have: tracked keywords your listing covers badly, and phrases mined from the competitors' names and subtitles,
  ordered by how many of them use the term. A suggestion, not advice. A phrase you do not track yet can be tracked
  in one click.
  Props: api, workspaceId, members, keywords, canWrite, version, onchanged.
-->
<script lang="ts">
  import type { Api } from '../../lib/api.ts';
  import {
    type AsoCompetitor,
    type AsoGapsResponse,
    type AsoKeyword,
    asoErrorMessage,
    asoViewHref,
    countryForLocale,
    fitStatusInfo,
    localesOf,
  } from '../../lib/aso/aso.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { gapsLead } from '../../lib/aso/lead.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { summaryLine } from '../../lib/section-state.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';

  let {
    api,
    workspaceId,
    members,
    keywords,
    canWrite,
    version,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    members: AppSummary[];
    keywords: AsoKeyword[];
    canWrite: boolean;
    version: number;
    onchanged: () => Promise<void>;
  } = $props();

  const uid = $props.id();
  const locales = $derived(localesOf(keywords));
  let locale = $state('');
  let data = $state<Record<string, AsoGapsResponse | undefined>>({});
  let names = $state<Record<string, Record<string, string> | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let busy = $state<string | null>(null);
  let generation = 0;

  $effect(() => {
    void version;
    const wanted = locale === '' || locales.indexOf(locale) >= 0 ? locale : '';
    const list = members;
    const mine = ++generation;
    void (async () => {
      const nextData: Record<string, AsoGapsResponse | undefined> = {};
      const nextNames: Record<string, Record<string, string> | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          try {
            const [g, c] = await Promise.all([api.asoGaps(workspaceId, m.id, wanted === '' ? undefined : wanted), api.asoCompetitors(workspaceId, m.id)]);
            nextData[m.id] = g;
            nextNames[m.id] = c.competitors.reduce<Record<string, string>>((acc, x: AsoCompetitor) => {
              acc[x.id] = x.name;
              return acc;
            }, {});
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, t('aso:gaps.loadFailed'));
          }
        }),
      );
      if (mine !== generation) return;
      data = nextData;
      names = nextNames;
      errors = bad;
      loading = false;
    })();
  });

  function usedBy(app: AppSummary, ids: string[]): string {
    const map = names[app.id] ?? {};
    const shown = ids.slice(0, 2).map((id) => map[id] ?? t('aso:gaps.aCompetitor'));
    const names = formatList(shown, { type: 'unit' });
    return ids.length > 2 ? t('aso:gaps.usedByMore', { names, count: ids.length - 2 }) : names;
  }

  const lead = $derived(
    gapsLead(members.flatMap((m) => { const d = data[m.id]; return d ? [{ gaps: d.gaps.length, competitors: d.competitors }] : []; })),
  );
  const noCompetitors = $derived(members.every((m) => (data[m.id]?.competitors ?? 0) === 0));

  async function track(app: AppSummary, d: AsoGapsResponse, term: string) {
    busy = `${app.id}|${term}`;
    try {
      const country = countryForLocale(d.locale, keywords.filter((k) => k.appId === app.id));
      const out = await api.addAsoKeywords(workspaceId, app.id, [{ term, locale: d.locale, ...(country ? { country } : {}) }]);
      const first = out.results[0];
      if (first?.status === 'created') toast.success(t('aso:track.created', { term }));
      else if (first?.status === 'exists') toast.info(t('aso:track.exists', { term }));
      else toast.error(first?.message ?? t('aso:track.failed'));
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:track.failed')));
    } finally {
      busy = null;
    }
  }
</script>

<div class="gaps stack roomy">
  {#if !loading && members.some((m) => data[m.id])}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="gaps-lead">
      {#snippet actions()}
        {#if noCompetitors && members[0]}
          <Button variant="primary" icon="plus" href={asoViewHref(members[0].id, 'competitors', address.platform)}>{t('aso:competitor.follow')}</Button>
        {/if}
      {/snippet}
    </PageLead>
  {/if}
  {#if locales.length > 1}
    <div class="row">
      <label for="{uid}-locale" class="muted">{t('aso:label.locale')}</label>
      <select id="{uid}-locale" bind:value={locale}>
        <option value="">{t('aso:label.mostUsed', { locale: locales[0] })}</option>
        {#each locales as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
  {/if}

  {#if loading}
    <Skeleton width="100%" height="120px" />
  {:else}
    {#each members as app (app.id)}
      {@const d = data[app.id]}
      {#snippet link(text: string)}<a href={asoViewHref(app.id, 'competitors', address.platform)}>{text}</a>{/snippet}
      <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={d ? summaryLine([t('aso:count.gaps', { count: d.gaps.length }), d.locale, t('aso:count.competitorsRead', { count: d.competitors })]) : ''}>
        <div class="stack">
          <div class="row head">
            {#if d}
              <span class="muted">{t('aso:gaps.read', { locale: d.locale, count: d.competitors })}</span>
              <InfoTip label={t('aso:gaps.aboutLabel')} align="start">
                <p class="tip">
                  {t('aso:gaps.aboutText')}
                </p>
                {#if d.notes.length > 0}
                  <ul class="plain">{#each d.notes as n (n)}<li>{n}</li>{/each}</ul>
                {/if}
              </InfoTip>
            {/if}
          </div>
          {#if errors[app.id]}
            <Alert tone="error">{errors[app.id]}</Alert>
          {:else if d && d.competitors === 0}
            <p class="none"><T key="aso:gaps.noCompetitors" tags={{ link }} /></p>
          {:else if d && d.gaps.length === 0}
            <p class="none">{t('aso:gaps.none')}</p>
          {:else if d}
            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr>
                    <th scope="col">{t('aso:gaps.term')}</th>
                    <th scope="col">{t('aso:gaps.usedBy')}</th>
                    <th scope="col">{t('aso:gaps.yourListing')}</th>
                    {#if canWrite}<th scope="col"><span class="visually-hidden">{t('aso:track.button')}</span></th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each d.gaps as g (g.term)}
                    {@const status = fitStatusInfo[g.ourStatus]}
                    <tr>
                      <th scope="row" class="term">{g.term} {#if g.origin === 'tracked'}<Badge tone="info">{t('aso:gaps.tracked')}</Badge>{/if}</th>
                      <td>
                        {#if g.inTitle.length > 0}
                          <span title={t('aso:gaps.inTitleTip')}>{usedBy(app, g.inTitle)}</span>
                          <span class="muted">{t('aso:gaps.inTitle')}</span>
                        {:else}
                          <span>{usedBy(app, g.inDescription)}</span> <span class="muted">{t('aso:gaps.inDescription')}</span>
                        {/if}
                      </td>
                      <td><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check-circle' : status.tone === 'bad' ? 'x-circle' : 'alert-triangle'}>{t(status.labelKey)}</Badge></td>
                      {#if canWrite}
                        <td class="actions">
                          {#if g.origin === 'idea'}
                            <Button size="sm" icon="plus" loading={busy === `${app.id}|${g.term}`} onclick={() => track(app, d, g.term)}>{t('aso:track.button')}</Button>
                          {/if}
                        </td>
                      {/if}
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </div>
      </Section>
    {/each}
  {/if}
</div>

<style>
  .roomy {
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact th),
  .roomy :global(table.compact td) {
    padding-block: var(--space-3);
    font-size: 0.9375rem;
  }

  .roomy :global(table.compact thead th) {
    font-size: var(--text-sm);
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
  }

  .term {
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .none {
    margin: var(--space-2) 0;
  }

  .tip {
    margin: 0 0 var(--space-2);
  }

  .plain {
    padding: 0;
    margin: 0;
    list-style: none;
  }
</style>
