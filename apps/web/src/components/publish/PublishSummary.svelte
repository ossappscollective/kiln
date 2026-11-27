<!--
  PublishSummary: "What will be published", the block at the top of the publish dialog that says WHAT goes out and WHERE before the
  steps do: the app and the store, the track and the share of users (or the App Store submission), the version and the build it
  names (with a link to the store's console and the upload date where the store gives one), the release notes, the assets and texts,
  and one plain sentence on what Publish does for the ticked steps. Display only: the words come from lib/publish-summary.ts (a pure
  function of the plan), so it follows the ticks and the Track and Share fields. While the plan is being made it shows a quiet line and
  a skeleton (null summary). Long texts sit behind disclosures, collapsed: the release notes (the app's default language first, the
  other languages as chips that open), the changed listing texts (new text, and the text in the store when the plan carries it) and the
  changed graphics sets (thumbnails drawn only once opened, loaded lazily).
  Props: summary (PublishSummary, or null while the first plan is made), busy (the plan is being made again: the old words stay),
  api, workspaceId (optional: they let the block read, for this app only, the default language of the listing and the upload date of
  an App Store build, and draw the thumbnails; without them the block shows what the plan holds), app (optional: its Apple id makes
  the link go to the app's TestFlight page).
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import type { Api } from '../../lib/api.ts';
  import { reportShown } from '../../lib/app-state/dev-assert.ts';
  import { listingStore } from '../../lib/app-state/listing-store.svelte.ts';
  import { assetFileUrl } from '../../lib/assets/assets.ts';
  import { stagedBlobUrl } from '../../lib/assets/sync.ts';
  import { formatDateTime, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { buildDate, buildLink, notesDetail, type PublishSummary } from '../../lib/publish-summary.ts';
  import type { StoreBuildItem } from '../../lib/builds.ts';
  import Disclosure from '../ui/Disclosure.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import SubmitReadiness from './SubmitReadiness.svelte';

  let {
    summary,
    busy = false,
    api,
    workspaceId,
    app,
    onnavigate,
  }: {
    summary: PublishSummary | null;
    /** Called when a link of the readiness list to a place in Kiln is followed (the dialog closes). */
    onnavigate?: (() => void) | undefined;
    busy?: boolean | undefined;
    api?: Api | undefined;
    workspaceId?: string | undefined;
    app?: { storeAppId: string | null } | undefined;
  } = $props();

  const uid = $props.id();

  // What is read for this app, once per app and only when the block can ask (never a write).
  // The default language is the store read's base locale (`listingStore`: the language the store declares, the App Store's primary locale
  // included, else English, else the first): the same one the checks and the fix bar compare with.
  let stored = $state<StoreBuildItem[] | null>(null);
  let readFor = '';
  const defaultLocale = $derived(
    workspaceId !== undefined && summary !== null ? (listingStore.defaultLocale(workspaceId, summary.appId)?.locale ?? null) : null,
  );

  // Dev monitor: the default language this block compares notes with is the one the checks and the fix bar use.
  $effect(() => {
    if (summary !== null && defaultLocale !== null) reportShown(`defaultLocale:${summary.appId}`, defaultLocale, 'publishSummary');
  });

  $effect(() => {
    const appId = summary?.appId ?? '';
    const reader = api;
    const ws = workspaceId;
    const wantsBuilds = (summary?.build?.numbers.length ?? 0) > 0;
    if (!reader || !ws || appId === '') return;
    untrack(() => {
      if (readFor !== appId) {
        readFor = appId;
        stored = null;
        void listingStore.load(reader, ws, appId);
      }
      if (wantsBuilds && stored === null) {
        reader
          .buildArtifacts(ws, appId)
          .then((list) => {
            if (readFor === appId) stored = list.store;
          })
          .catch(() => undefined);
      }
    });
  });

  const notes = $derived(summary ? (defaultLocale !== null ? notesDetail(summary.noteEntries, defaultLocale) : summary.notes) : null);
  const link = $derived(summary?.build ? buildLink(summary.build, app?.storeAppId) : null);
  const date = $derived(summary ? buildDate(summary.build, stored) : null);

  let fullNotes = $state(false);
  let openOthers = $state<Record<string, boolean>>({});
  let fullText = $state<Record<string, boolean>>({});
  /** Per thumbnail: which address is tried (0 the staged upload, 1 the repository file, 2 none worked). */
  let attempt = $state<Record<string, number>>({});

  const thumbSrc = (appId: string, file: { key: string; oid: string; path: string }): string | null => {
    if (!workspaceId) return null;
    const step = attempt[file.key] ?? 0;
    if (step === 0 && file.oid !== '') return stagedBlobUrl(workspaceId, appId, file.oid);
    if (step <= 1 && file.path !== '') return assetFileUrl(workspaceId, appId, file.path, null);
    return null;
  };
  const failed = (file: { key: string; oid: string; path: string }) => {
    const step = attempt[file.key] ?? 0;
    attempt[file.key] = step === 0 && file.oid !== '' && file.path !== '' ? 1 : 2;
  };
</script>

<section class="summary" aria-labelledby="{uid}-title" aria-busy={busy || summary === null} data-testid="publish-summary">
  <h3 id="{uid}-title" class="title">{t('publish:summary.title')}</h3>

  {#if summary === null}
    <div class="stack" role="status">
      <p class="muted small">{t('publish:summary.loading')}</p>
      <Skeleton width="80%" height="14px" />
      <Skeleton width="55%" height="14px" />
    </div>
  {:else}
    <dl class="facts">
      {#each summary.rows as row (row.id)}
        <dt>{row.label}</dt>
        <dd data-testid="summary-{row.id}">
          <span class:mono={row.mono}>{row.value}</span>
          {#if row.chip}<span class="chip">{row.chip}</span>{/if}
          {#if link && (row.id === 'build' || row.id === 'release')}
            <a class="console" href={link.href} target="_blank" rel="noopener noreferrer" aria-label={link.label} title={link.title} data-testid="summary-build-link">{link.text} <Icon name="external-link" size={12} /></a>
          {/if}
          {#if row.hint}<span class="hint">{row.hint}</span>{/if}
          {#if date && (row.id === 'build' || row.id === 'release')}
            {#if date.state === 'known'}
              <span class="hint" data-testid="summary-build-date"><time datetime={new Date(date.at).toISOString()}>{t('publish:summary.build.uploaded', { date: formatDateTime(date.at), ago: formatRelativeTime(date.at) })}</time></span>
            {:else if date.state === 'notProvided'}
              <span class="hint" data-testid="summary-build-date" title={t('publish:summary.build.dateNotProvidedTitle')}>{t('publish:summary.build.dateNotProvided')}</span>
            {:else}
              <span class="hint" data-testid="summary-build-date" title={date.reason?.title ?? t('publish:summary.build.dateNotReadTitle')}>{date.reason?.text ?? t('publish:summary.build.dateNotRead')}</span>
            {/if}
          {/if}
        </dd>
      {/each}
    </dl>

    <!-- Whether the draft could be submitted once this push is made, known now (the same rules the submit itself applies). -->
    <SubmitReadiness view={summary.readiness} {onnavigate} />

    {#if notes && (notes.shown || notes.others.length > 0)}
      {#snippet notesHead()}<span title={notes?.hint ?? undefined} data-testid="summary-notes-title">{notes?.title}</span>{/snippet}
      <Disclosure summary={notesHead}>
        <div class="stack notes">
          {#if notes.hint}<p class="muted small" data-testid="summary-notes-hint">{notes.hint}</p>{/if}
          {#if notes.shown}
            <div>
              {#if fullNotes}
                <p class="line pre">{notes.shown.text.trim()}</p>
              {:else}
                {#each notes.shown.lines as line, i (i)}<p class="line">{line}</p>{/each}
                {#if notes.shown.truncated}<p class="line muted" aria-hidden="true">&hellip;</p>{/if}
              {/if}
              {#if notes.shown.truncated}
                <button type="button" class="link small" aria-expanded={fullNotes} onclick={() => (fullNotes = !fullNotes)}>{fullNotes ? t('publish:summary.showLess') : t('publish:summary.showFull')}</button>
              {/if}
            </div>
          {/if}
          {#if notes.others.length > 0}
            <div>
              <p class="locale">{t('publish:summary.notes.others')}</p>
              <ul class="locales">
                {#each notes.others as other (other.locale)}
                  <li>
                    {#if other.empty}
                      <span class="chip">{other.locale}<span class="muted"> · {t('publish:summary.notes.empty')}</span></span>
                    {:else}
                      <button type="button" class="chip chip-button" aria-expanded={openOthers[other.locale] === true} aria-controls="{uid}-note-{other.locale}" aria-label={t('publish:summary.notes.expand', { locale: other.locale })} onclick={() => (openOthers[other.locale] = !openOthers[other.locale])}>{other.locale}</button>
                    {/if}
                  </li>
                {/each}
              </ul>
              {#each notes.others as other (other.locale)}
                {#if openOthers[other.locale] === true && !other.empty}
                  <div id="{uid}-note-{other.locale}" class="other-note">
                    <p class="locale">{other.locale}</p>
                    <p class="line pre">{other.text.trim()}</p>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      </Disclosure>
    {/if}

    {#if summary.texts && summary.texts.total > 0}
      {@const texts = summary.texts}
      <Disclosure summary={t('publish:summary.details.texts', { count: texts.total })}>
        <ul class="items" data-testid="summary-texts">
          {#each texts.items as item (item.id)}
            <li class="item">
              <p class="item-head"><strong>{item.label}</strong> <span class="muted">{item.locale}</span>{#if item.isNew} <span class="chip">{t('publish:summary.text.newLanguage')}</span>{/if}</p>
              <p class="line pre">{fullText[item.id] === true ? item.after : item.excerpt}</p>
              {#if item.before !== null && item.before.trim() !== ''}
                <p class="locale">{t('publish:summary.text.before')}</p>
                <p class="line pre muted">{fullText[item.id] === true ? item.before : item.beforeExcerpt}</p>
              {/if}
              {#if item.truncated || item.beforeTruncated}
                <button type="button" class="link small" aria-expanded={fullText[item.id] === true} onclick={() => (fullText[item.id] = !fullText[item.id])}>{fullText[item.id] === true ? t('publish:summary.showLess') : t('publish:summary.showFull')}</button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if texts.more > 0}<p class="muted small">{t('publish:summary.more', { count: texts.more })}</p>{/if}
      </Disclosure>
    {/if}

    {#if summary.graphics && summary.graphics.total > 0}
      {@const graphics = summary.graphics}
      <Disclosure summary={t('publish:summary.details.graphics', { count: graphics.total })}>
        <ul class="items" data-testid="summary-graphics">
          {#each graphics.items as set (set.id)}
            <li class="item">
              <p class="item-head"><strong>{set.title}</strong> <span class="muted">{set.locale} · {t('publish:summary.graphics.files', { count: set.fileCount })}</span></p>
              {#if set.files.length > 0}
                <ul class="thumbs">
                  {#each set.files as file, i (file.key)}
                    {@const src = thumbSrc(summary.appId, file)}
                    <li class="thumb">
                      {#if src}
                        <img {src} loading="lazy" decoding="async" height="72" alt={t('publish:summary.graphics.thumbAlt', { position: i + 1, count: set.fileCount, title: set.title, locale: set.locale })} onerror={() => failed(file)} />
                      {:else}
                        <span class="thumb-name small muted" title={file.name}>{file.name || t('publish:summary.graphics.noPreview')}</span>
                      {/if}
                      {#if file.width !== null && file.height !== null}<span class="small muted">{t('assets:dimensions', { width: file.width, height: file.height })}</span>{/if}
                    </li>
                  {/each}
                  {#if set.moreFiles > 0}<li class="thumb small muted">{t('publish:summary.graphics.moreFiles', { count: set.moreFiles })}</li>{/if}
                </ul>
              {:else}
                <p class="muted small">{t('publish:summary.graphics.noFiles')}</p>
              {/if}
            </li>
          {/each}
        </ul>
        {#if graphics.more > 0}<p class="muted small">{t('publish:summary.more', { count: graphics.more })}</p>{/if}
      </Disclosure>
    {/if}

    {#if summary.footnote}<p class="muted small" data-testid="summary-footnote">{summary.footnote}</p>{/if}
    <p class="outcome" data-testid="summary-outcome"><Icon name="info" size={14} /> <span>{summary.outcome}</span></p>
  {/if}
</section>

<style>
  .summary {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4);
    color: var(--ink);
    background: var(--surface-sunken);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
  }

  .title {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }

  .small {
    margin: 0;
    font-size: var(--text-sm);
  }

  .facts {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: var(--space-1) var(--space-4);
    margin: 0;
  }

  .facts dt {
    color: var(--muted);
  }

  .facts dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .mono {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.95em;
  }

  .hint {
    display: block;
    font-size: var(--text-sm);
    color: var(--muted);
  }

  .chip {
    display: inline-block;
    padding: 0 var(--space-2);
    margin-inline-start: var(--space-2);
    font-size: var(--text-sm);
    color: var(--chip-ink);
    background: var(--chip-bg);
    border-radius: var(--radius-lg, 999px);
  }

  .notes {
    min-width: 0;
  }

  .locale {
    margin: 0;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--muted);
  }

  .line {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .locales {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .locales .chip {
    margin-inline-start: 0;
  }

  .console {
    display: inline-flex;
    gap: var(--space-1);
    align-items: baseline;
    margin-inline-start: var(--space-2);
    font-size: var(--text-sm);
  }

  .pre {
    white-space: pre-wrap;
  }

  .chip-button {
    margin-inline-start: 0;
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
    border: 0;
  }

  .other-note {
    margin-top: var(--space-2);
  }

  .items {
    display: grid;
    gap: var(--space-3);
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .item {
    min-width: 0;
  }

  .item-head {
    margin: 0;
  }

  .thumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    padding: 0;
    margin: var(--space-1) 0 0;
    list-style: none;
  }

  .thumb {
    display: grid;
    gap: 2px;
    justify-items: start;
    max-width: 10rem;
  }

  .thumb img {
    display: block;
    width: auto;
    max-width: 10rem;
    height: 72px;
    object-fit: contain;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--radius-md, 6px);
  }

  .thumb-name {
    overflow-wrap: anywhere;
  }

  .outcome {
    display: flex;
    gap: var(--space-2);
    align-items: baseline;
    margin: 0;
    padding-top: var(--space-3);
    color: var(--ink);
    border-top: 1px solid var(--line);
  }
</style>
