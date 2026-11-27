<!--
  AsoIdeas: keyword ideas mined from your own live listing and the texts of the competitors you follow: phrases that
  occur at least twice and are not tracked yet, each with where it came from and why it is suggested. One click
  tracks it. The score behind the order is a frequency in the stored texts, not a search volume or a popularity (no
  free store source publishes one); the tip says so. A suggestion, never advice.
  Props: api, workspaceId, role, members, keywords, canWrite, version, onchanged.
  "Suggest keywords" (AI, drawn only when AI is on and the role may track keywords) asks an assistant for ideas in the chosen locale; they arrive as a
  proposal in the AI suggestions tray above, and nothing is tracked until accepted there. The ideas below are counted from stored text, with no AI.
-->
<script lang="ts">
  import type { Role } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import {
    type AsoIdeasResponse,
    type AsoKeyword,
    asoErrorMessage,
    asoViewHref,
    countryForLocale,
    ideaSourceText,
    ideaTexts,
    ideaWhy,
    localesOf,
  } from '../../lib/aso/aso.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { ideasLead } from '../../lib/aso/lead.ts';
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
  import SuggestKeywords from '../ai/SuggestKeywords.svelte';
  import T from '../ui/T.svelte';
  import SuggestKeywordsFromReviews from '../ai/SuggestKeywordsFromReviews.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    keywords,
    canWrite,
    version,
    onchanged,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    keywords: AsoKeyword[];
    canWrite: boolean;
    version: number;
    onchanged: () => Promise<void>;
  } = $props();

  const uid = $props.id();
  const locales = $derived(localesOf(keywords));
  /** '' lets the server pick the locale most keywords use. */
  let locale = $state('');
  let data = $state<Record<string, AsoIdeasResponse | undefined>>({});
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
      const next: Record<string, AsoIdeasResponse | undefined> = {};
      const bad: Record<string, string | undefined> = {};
      await Promise.all(
        list.map(async (m) => {
          try {
            next[m.id] = await api.asoIdeas(workspaceId, m.id, wanted === '' ? undefined : wanted);
          } catch (e) {
            bad[m.id] = asoErrorMessage(e, t('aso:ideas.loadFailed'));
          }
        }),
      );
      if (mine !== generation) return;
      data = next;
      errors = bad;
      loading = false;
    })();
  });

  const lead = $derived(
    ideasLead(members.flatMap((m) => { const d = data[m.id]; return d ? [{ ideas: d.ideas.length, competitors: d.basedOn.competitors, ownListing: d.basedOn.ownListing }] : []; })),
  );

  async function track(app: AppSummary, d: AsoIdeasResponse, term: string) {
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

{#snippet suggest()}
  {#if canWrite}
    <div class="suggest-row">
      <SuggestKeywords
        {api}
        {workspaceId}
        {role}
        {members}
        {keywords}
        localeFor={(app) => (locale !== '' && locales.indexOf(locale) >= 0 ? locale : (data[app.id]?.locale ?? null))}
      />
      <SuggestKeywordsFromReviews
        {api}
        {workspaceId}
        {role}
        {members}
        {keywords}
        localeFor={(app) => (locale !== '' && locales.indexOf(locale) >= 0 ? locale : (data[app.id]?.locale ?? null))}
      />
    </div>
  {/if}
{/snippet}

<div class="ideas stack roomy">
  {#if loading}
    {@render suggest()}
  {:else}
    <PageLead headline={lead.headline} hint={lead.hint} tone={lead.tone} testid="ideas-lead">
      {#snippet actions()}{@render suggest()}{/snippet}
    </PageLead>
  {/if}
  <!-- guard-ok R5: layout, the locale picker shows only when there is more than one locale to pick -->
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
      <Section title={platformLabel(app.platform)} key="platform.{app.platform}" variant="plain" summary={d ? summaryLine([t('aso:count.ideas', { count: d.ideas.length }), d.locale]) : ''}>
        <div class="stack">
          <div class="row head">
            {#if d}
              <span class="muted">{t('aso:ideas.basedOn', { locale: d.locale, source: ideaSourceText(d.basedOn) })}</span>
              <InfoTip label={t('aso:ideas.aboutLabel')} align="start">
                <p class="tip">
                  {t('aso:ideas.aboutText')}
                </p>
                {#if d.notes.length > 0}
                  <ul class="plain">{#each d.notes as n (n)}<li>{n}</li>{/each}</ul>
                {/if}
              </InfoTip>
            {/if}
          </div>
          {#if errors[app.id]}
            <Alert tone="error">{errors[app.id]}</Alert>
          {:else if d && d.ideas.length === 0}
            <p class="none">
              {t('aso:ideas.none')} {#if !d.basedOn.ownListing}{t('aso:ideas.syncApp')} {/if}{#if d.basedOn.competitors === 0}<T key="aso:ideas.followCompetitor" tags={{ link }} />{/if}
            </p>
          {:else if d}
            {@const texts = ideaTexts(d.basedOn)}
            <div class="table-wrap">
              <table class="compact">
                <thead>
                  <tr>
                    <th scope="col">{t('aso:ideas.idea')}</th>
                    <th scope="col">{t('aso:ideas.why')}</th>
                    <th scope="col" class="num">{t('aso:ideas.score')}</th>
                    {#if canWrite}<th scope="col"><span class="visually-hidden">{t('aso:track.button')}</span></th>{/if}
                  </tr>
                </thead>
                <tbody>
                  {#each d.ideas as idea (idea.term)}
                    <tr>
                      <th scope="row" class="term">{idea.term} {#if idea.words > 1}<Badge>{t('aso:ideas.words', { count: idea.words })}</Badge>{/if}</th>
                      <td class="muted">{ideaWhy(idea, texts)}</td>
                      <td class="num" title={t('aso:ideas.scoreTip')}>{idea.localScore}</td>
                      {#if canWrite}
                        <td class="actions">
                          <Button size="sm" icon="plus" loading={busy === `${app.id}|${idea.term}`} onclick={() => track(app, d, idea.term)}>{t('aso:track.button')}</Button>
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
  .suggest-row:empty {
    display: none;
  }

  .suggest-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

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
