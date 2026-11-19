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
  } from '../../lib/aso.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { countOf, summaryLine } from '../../lib/section-state.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Section from '../ui/Section.svelte';
  import Skeleton from '../ui/Skeleton.svelte';

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
            bad[m.id] = asoErrorMessage(e, 'Could not load the gaps.');
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
    const shown = ids.slice(0, 2).map((id) => map[id] ?? 'a competitor');
    return shown.join(', ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
  }

  async function track(app: AppSummary, d: AsoGapsResponse, term: string) {
    busy = `${app.id}|${term}`;
    try {
      const country = countryForLocale(d.locale, keywords.filter((k) => k.appId === app.id));
      const out = await api.addAsoKeywords(workspaceId, app.id, [{ term, locale: d.locale, ...(country ? { country } : {}) }]);
      const first = out.results[0];
      if (first?.status === 'created') toast.success(`Tracking “${term}”.`);
      else if (first?.status === 'exists') toast.info(`“${term}” is already tracked.`);
      else toast.error(first?.message ?? 'Could not track that keyword.');
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not track that keyword.'));
    } finally {
      busy = null;
    }
  }
</script>

<div class="gaps stack">
  {#if locales.length > 1}
    <div class="row">
      <label for="{uid}-locale" class="muted">Locale</label>
      <select id="{uid}-locale" bind:value={locale}>
        <option value="">Most used ({locales[0]})</option>
        {#each locales as l (l)}<option value={l}>{l}</option>{/each}
      </select>
    </div>
  {/if}

  {#if loading}
    <Skeleton width="100%" height="120px" />
  {:else}
    {#each members as app (app.id)}
      {@const d = data[app.id]}
      <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={d ? summaryLine([countOf(d.gaps.length, 'gap'), d.locale, countOf(d.competitors, 'competitor') + ' read']) : ''}>
        <div class="stack">
          <div class="row head">
            {#if d}
              <span class="muted">{d.locale}: {d.competitors} {d.competitors === 1 ? 'competitor' : 'competitors'} read</span>
              <InfoTip label="About these gaps" align="start">
                <p class="tip">
                  Terms competitors put in their names, subtitles or descriptions that your searched fields do not hold. It compares stored texts only; it does not know what people search for.
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
            <p class="none"><a href={asoViewHref(app.id, 'competitors', address.platform)}>Follow a competitor</a> to see which terms it uses that you do not.</p>
          {:else if d && d.gaps.length === 0}
            <p class="none">No gaps found: your listing has the terms the competitors use.</p>
          {:else if d}
            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr>
                    <th scope="col">Term</th>
                    <th scope="col">Used by</th>
                    <th scope="col">Your listing</th>
                    {#if canWrite}<th scope="col"><span class="visually-hidden">Track</span></th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each d.gaps as g (g.term)}
                    {@const status = fitStatusInfo[g.ourStatus]}
                    <tr>
                      <th scope="row" class="term">{g.term} {#if g.origin === 'tracked'}<Badge tone="info">Tracked</Badge>{/if}</th>
                      <td>
                        {#if g.inTitle.length > 0}
                          <span title="In the name or subtitle">{usedBy(app, g.inTitle)}</span>
                          <span class="muted">(name or subtitle)</span>
                        {:else}
                          <span>{usedBy(app, g.inDescription)}</span> <span class="muted">(description)</span>
                        {/if}
                      </td>
                      <td><Badge tone={status.tone} icon={status.tone === 'ok' ? 'check-circle' : status.tone === 'bad' ? 'x-circle' : 'alert-triangle'}>{status.label}</Badge></td>
                      {#if canWrite}
                        <td class="actions">
                          {#if g.origin === 'idea'}
                            <Button size="sm" icon="plus" loading={busy === `${app.id}|${g.term}`} onclick={() => track(app, d, g.term)}>Track</Button>
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
