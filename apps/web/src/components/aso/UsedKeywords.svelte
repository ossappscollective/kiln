<!--
  UsedKeywords: "Keywords your listing uses now", the first thing on Insights, Keywords. For each app in scope and one locale at a time it
  shows what the STORED store listing says today (the copy the last sync stored: nothing here contacts a store):
    - App Store: the entries of the hidden 100 byte keyword field, plus the words and phrases of the title and the subtitle.
    - Google Play: Play has NO keyword field, so the words and phrases are DERIVED here from the title, the short description and the full
      description. The view says so in plain words.
  Each keyword says where it appears (title, subtitle, keyword field, description), whether it is already tracked and its latest rank, and,
  for Google Play when a Play Console search terms file was imported, the visitors that came from searching it. "Track" adds it to the
  tracked keywords (the existing keywords endpoint: our own database; ranks are only read when "Check now" runs). "Edit" opens the field
  editor on the field and locale where the keyword lives: the text before and after, the character budget, and "Stage". Staging saves the
  text in our own database; nothing reaches a store from here. The App Store name and subtitle cannot be written by a draft push: their
  editor is for working the text out and copying it, and says so.
  With no stored listing the view says it has not been read yet and points to Sync.
  Props: api, workspaceId, role, members (the app records in scope), config, keywords (all tracked ones), canWrite (may track), onchanged
  (read the tracked keywords again), now.
-->
<script lang="ts">
  import { can, type Role, supports } from '@kiln/core';
  import { untrack } from 'svelte';
  import { address } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { openStatusPopover } from '../../lib/app-page.ts';
  import { appAddress } from '../../lib/app-scope.ts';
  import { type AsoConfig, type AsoKeyword, type AsoListingKeywordsResponse, addSummaryText, asoErrorMessage, chunk, sumAddSummary } from '../../lib/aso/aso.ts';
  import { termKeywordItem, freshnessText, termMark } from '../../lib/aso/listing.ts';
  import {
    APP_STORE_NOTE,
    NOT_READ_TEXT,
    PLAY_DERIVED_NOTE,
    type UsedKeyword,
    defaultLocale,
    usedKeywords,
    usedSummary,
    visitorsText,
  } from '../../lib/aso/keyword-use.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { canStage, findStagedText } from '../../lib/staged.ts';
  import { stagedStore } from '../../lib/staged-store.svelte.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import { territoryName } from '../../lib/reviews/reviews.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import FieldEditor from '../listing/FieldEditor.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import T from '../ui/T.svelte';

  let {
    api,
    workspaceId,
    role,
    members,
    config,
    keywords,
    canWrite,
    onchanged,
    now,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    members: AppSummary[];
    config: AsoConfig | null;
    keywords: AsoKeyword[];
    canWrite: boolean;
    onchanged: () => Promise<void>;
    now: number;
  } = $props();

  const multi = $derived(members.length > 1);
  const mayStage = $derived(canStage(role));
  const canSync = $derived(can(role, 'apps.sync'));
  const depth = $derived(config?.limits.rankDepth ?? 50);

  let data = $state<Record<string, AsoListingKeywordsResponse | undefined>>({});
  let errors = $state<Record<string, string | undefined>>({});
  let loading = $state(true);
  let generation = 0;
  /** The locale shown per app, and the storefront picked for a locale (`appId|locale`). */
  let pickedLocale = $state<Record<string, string | undefined>>({});
  let pickedCountry = $state<Record<string, string | undefined>>({});
  /** Imported Google Play search terms per `appId|locale`. */
  let search = $state<Record<string, { term: string; visitors: number | null; installs: number | null }[] | undefined>>({});

  const key = $derived(`${workspaceId}/${members.map((m) => m.id).join(',')}`);

  async function load() {
    const mine = ++generation;
    const next: Record<string, AsoListingKeywordsResponse | undefined> = {};
    const bad: Record<string, string | undefined> = {};
    await Promise.all(
      members.map(async (m) => {
        try {
          next[m.id] = await api.asoListingKeywords(workspaceId, m.id);
        } catch (e) {
          bad[m.id] = asoErrorMessage(e, t('aso:used.loadFailed'));
        }
        void stagedStore.load(api, workspaceId, m.id);
      }),
    );
    if (mine !== generation) return;
    data = next;
    errors = bad;
    loading = false;
  }

  $effect(() => {
    void key;
    untrack(() => {
      loading = true;
      pickedLocale = {};
      search = {};
      void load();
    });
  });

  const sections = $derived(
    members.map((app) => {
      const d = data[app.id];
      const mine = keywords.filter((k) => k.appId === app.id);
      const locale = d && d.locales.length > 0 ? (pickedLocale[app.id] ?? defaultLocale(d.locales, mine)) : null;
      const entry = d?.locales.find((l) => l.locale === locale);
      const countries = locale === null ? undefined : { [locale]: pickedCountry[`${app.id}|${locale}`] };
      const used =
        entry && locale !== null
          ? usedKeywords({
              platform: app.platform,
              locales: [entry],
              tracked: mine.map((k) => ({ id: k.id, term: k.term, country: k.country, locale: k.locale, state: k.state, rank: k.rank })),
              ...(search[`${app.id}|${locale}`] ? { searchTerms: search[`${app.id}|${locale}`] } : {}),
              ...(countries ? { countries } : {}),
              depth,
            })[0]
          : undefined;
      return { app, d, locale, used };
    }),
  );

  // Google Play: the visitors an imported Console file reports per search term, for the locale shown. Best effort: no file, no right or an
  // error just means no figures.
  $effect(() => {
    const wanted = sections
      .filter((s) => supports(s.app.platform, 'unofficialSearch') && s.locale !== null && search[`${s.app.id}|${s.locale}`] === undefined)
      .map((s) => ({ id: s.app.id, locale: s.locale as string }));
    if (wanted.length === 0 || !can(role, 'aso.read')) return;
    untrack(() => {
      for (const w of wanted) {
        search[`${w.id}|${w.locale}`] = [];
        api
          .asoSearchTerms(workspaceId, w.id, { locale: w.locale, limit: 200 })
          .then((r) => {
            search[`${w.id}|${w.locale}`] = r.terms.map((row) => ({ term: row.term, visitors: row.visitors, installs: row.installs }));
          })
          .catch(() => undefined);
      }
    });
  });

  const hasSearch = (appId: string, locale: string | null): boolean => locale !== null && (search[`${appId}|${locale}`]?.length ?? 0) > 0;

  // ----- Track
  let busy = $state('');

  async function track(app: AppSummary, used: { locale: string; country: string }, items: UsedKeyword[], label: string) {
    if (busy !== '' || items.length === 0) return;
    busy = label;
    try {
      const per = config?.limits.maxKeywordsPerRequest ?? 50;
      const sums = [];
      for (const part of chunk(items.map((item) => termKeywordItem(used, item)), per)) sums.push((await api.addAsoKeywords(workspaceId, app.id, part)).summary);
      const sum = sumAddSummary(sums);
      const message = addSummaryText(sum, config?.limits.maxKeywordsPerApp);
      if (sum.created > 0) toast.success(t('aso:used.added', { message }));
      else toast.error(message);
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, t('aso:used.addFailed')));
    } finally {
      busy = '';
    }
  }

  // ----- Edit
  let editing = $state<{ app: AppSummary; locale: string; field: string } | null>(null);
  let editorOpen = $state(false);

  function edit(app: AppSummary, locale: string, field: string) {
    editing = { app, locale, field };
    editorOpen = true;
  }

  const stagedFlag = (app: AppSummary, locale: string, field: string): boolean => findStagedText(stagedStore.view(app.id), locale, field) !== null;
  const clip = (text: string, max = 160): string => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);
</script>

<section class="used stack" aria-labelledby="used-kw-title">
  <div class="row head">
    <h2 id="used-kw-title" class="title">{t('aso:used.title')}</h2>
    <InfoTip label={t('aso:used.aboutLabel')} align="start" width="30rem">
      <div class="tip stack tight">
        <p>{t('aso:used.about1')}</p>
        <p><T key="aso:used.about2" /></p>
        <p><T key="aso:used.about3" /></p>
        <p>{t('aso:used.about4', { note: t(APP_STORE_NOTE) })}</p>
      </div>
    </InfoTip>
  </div>

  {#if loading}
    <div role="status" aria-label={t('aso:used.loading')} class="stack">
      <Skeleton width="100%" height="36px" />
      <Skeleton width="100%" height="120px" />
    </div>
  {:else}
    {#each sections as s (s.app.id)}
      {@const d = s.d}
      {@const used = s.used}
      <section class="app stack" aria-label={t('aso:used.sectionLabel', { platform: platformLabel(s.app.platform) })}>
        <div class="row head">
          {#if multi}<h3 class="eyebrow">{platformLabel(s.app.platform)}</h3>{/if}
          <span class="muted small">{freshnessText(s.app.platform, d?.readAt ?? null, now)}</span>
          {#if d?.error}<span class="muted small">{t('aso:used.readFailed', { error: d.error })}</span>{/if}
        </div>

        {#if errors[s.app.id]}
          <Alert tone="error">{errors[s.app.id]}</Alert>
        {:else if d && d.locales.length === 0}
          <div class="empty card">
            <p><strong>{t('aso:kw.notReadTitle')}</strong></p>
            <p class="muted">{t(NOT_READ_TEXT)}</p>
            <div class="row">
              {#if canSync}<Button variant="primary" icon="refresh" onclick={() => openStatusPopover()}>{t('aso:used.readNow')}</Button>{/if}
              <Button variant="link" href={appAddress(s.app.id, 'listing', address.platform)}>{t('aso:used.openListing')}</Button>
            </div>
            {#if !canSync}<p class="muted small">{t('aso:used.adminSync')}</p>{/if}
          </div>
        {:else if d && used && s.locale !== null}
          <div class="row controls">
            <label class="row">
              <span class="muted small">{t('aso:ai.language')}</span>
              <select
                value={s.locale}
                aria-label={t('aso:used.localeOf', { platform: platformLabel(s.app.platform) })}
                onchange={(e) => (pickedLocale[s.app.id] = e.currentTarget.value)}
              >
                {#each d.locales as l (l.locale)}<option value={l.locale}>{l.locale}</option>{/each}
              </select>
            </label>
            <span class="muted small">
              {#if used.storefronts.length > 1}
                <select
                  aria-label={t('aso:used.storefrontFor', { locale: s.locale })}
                  value={used.country}
                  onchange={(e) => (pickedCountry[`${s.app.id}|${s.locale}`] = e.currentTarget.value)}
                >
                  {#each used.storefronts as c (c)}<option value={c}>{c.toUpperCase()}</option>{/each}
                </select>
              {:else}
                <span title={territoryName(used.country)}>{used.country.toUpperCase()}</span>
              {/if}
              {t('aso:used.storefrontForRanks')}
            </span>
            <span class="spacer"></span>
            <span class="muted small">{usedSummary(used)}</span>
            {#if canWrite && used.trackable && used.untracked.length > 0}
              <Button
                size="sm"
                icon="plus"
                loading={busy === `all|${s.app.id}`}
                disabled={busy !== ''}
                onclick={() => track(s.app, used, used.untracked, `all|${s.app.id}`)}
              >
                {t('aso:used.trackUntracked', { count: used.untracked.length })}
              </Button>
            {/if}
          </div>

          <p class="muted note">{used.derived ? t(PLAY_DERIVED_NOTE) : t(APP_STORE_NOTE)}</p>

          <div class="table-wrap">
            <table class="compact">
              <caption class="visually-hidden">{t('aso:used.fieldsCaption', { locale: s.locale })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('aso:used.col.field')}</th>
                  <th scope="col">{t('aso:used.col.text')}</th>
                  <th scope="col">{t('aso:used.col.size')}</th>
                  <th scope="col"><span class="visually-hidden">{t('aso:used.edit')}</span></th>
                </tr>
              </thead>
              <tbody>
                {#each used.fields as f (f.info.id)}
                  <tr>
                    <th scope="row" class="fname">{f.info.label}</th>
                    <td class="ftext">
                      {#if f.text === ''}<span class="muted">{t('aso:used.empty')}</span>{:else}{clip(f.text)}{/if}
                      {#if stagedFlag(s.app, used.locale, f.info.id)}<Badge tone="info">{t('aso:used.staged')}</Badge>{/if}
                    </td>
                    <td class="num" class:over={f.meter.over} title={f.meter.text}>
                      {#if f.meter.limit !== null}{f.meter.unit === 'bytes' ? t('aso:used.sizeBytes', { used: f.meter.used, limit: f.meter.limit }) : t('aso:used.size', { used: f.meter.used, limit: f.meter.limit })}{:else}{f.meter.used}{/if}
                    </td>
                    <td class="act">
                      <Button size="sm" icon="edit" onclick={() => edit(s.app, used.locale, f.info.id)} title={f.info.stageable ? t('aso:used.editField', { field: f.info.lower }) : t('aso:used.workOut', { field: f.info.lower })}>
                        {t('aso:used.edit')}<span class="visually-hidden"> {t('aso:used.editHidden', { field: f.info.lower, locale: used.locale })}</span>
                      </Button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          {#if !used.hasText}
            <p class="muted">{t('aso:used.noText', { locale: s.locale })}</p>
          {:else}
            <div class="table-wrap">
              <table class="compact">
                <caption class="visually-hidden">{t('aso:used.keywordsCaption', { locale: s.locale })}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('aso:markets.keyword')}</th>
                    <th scope="col">{t('aso:used.col.where')}</th>
                    <th scope="col">{t('aso:used.col.rank')}</th>
                    {#if hasSearch(s.app.id, s.locale)}<th scope="col" class="num">{t('aso:used.col.visitors')}</th>{/if}
                    <th scope="col"><span class="visually-hidden">{t('aso:kw.col.actions')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {#each used.keywords as k (k.key)}
                    {@const mark = termMark(k)}
                    <tr>
                      <th scope="row" class="kw">
                        <span class="term">{k.term}</span>
                        {#if k.kind === 'phrase'}<span class="muted small">{t('aso:used.phrase')}</span>{/if}
                        {#if mark}<span class="mark {mark.tone}" title={mark.title}>{mark.text}</span>{/if}
                      </th>
                      <td>{k.where}{#if k.occurrences > 0}<span class="muted small"> · {k.occurrences}×</span>{/if}</td>
                      <td class:muted={!k.tracked}>{k.rankText}</td>
                      {#if hasSearch(s.app.id, s.locale)}<td class="num">{visitorsText(k.search)}</td>{/if}
                      <td class="act">
                        {#if !k.tracked && canWrite && used.trackable}
                          <Button
                            size="sm"
                            icon="plus"
                            loading={busy === `one|${s.app.id}|${k.key}`}
                            disabled={busy !== ''}
                            aria-label={t('aso:used.trackFor', { term: k.term, locale: used.locale, country: used.country.toUpperCase() })}
                            onclick={() => track(s.app, used, [k], `one|${s.app.id}|${k.key}`)}
                          >
                            {t('aso:track.button')}
                          </Button>
                        {/if}
                        {#if k.fieldIds[0] && mayStage}
                          <Button size="sm" variant="ghost" icon="edit" aria-label={t('aso:used.editWhere', { term: k.term, where: k.where })} onclick={() => edit(s.app, used.locale, k.fieldIds[0] as string)}>{t('aso:used.edit')}</Button>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if used.derived}<p class="muted small">{t('aso:used.playNote')}</p>{/if}
          {/if}
        {/if}
      </section>
    {/each}
  {/if}
</section>

{#if editing}
  <FieldEditor
    bind:open={editorOpen}
    {api}
    {workspaceId}
    {role}
    appId={editing.app.id}
    platform={editing.app.platform}
    locale={editing.locale}
    field={editing.field}
    onstaged={load}
  />
{/if}

<style>
  .title {
    margin: 0;
    font-size: var(--text-lg);
  }

  .head {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .controls {
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    align-items: center;
  }

  .small {
    font-size: var(--text-sm);
  }

  .note {
    margin: 0;
    font-size: var(--text-sm);
  }

  .tip p {
    margin: 0;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
  }

  .empty p {
    margin: 0;
  }

  .fname,
  .kw {
    text-align: left;
    vertical-align: top;
    white-space: nowrap;
  }

  .ftext {
    overflow-wrap: anywhere;
    max-width: 32rem;
  }

  .num {
    font-variant-numeric: tabular-nums;
    text-align: right;
    white-space: nowrap;
  }

  .num.over {
    color: var(--bad-ink);
  }

  .act {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
    white-space: nowrap;
  }

  .term {
    font-weight: var(--weight-medium);
  }

  .mark {
    margin-left: var(--space-1);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }

  .mark.warn {
    color: var(--warn-ink);
  }

  .mark.info {
    color: var(--info-ink);
  }
</style>
