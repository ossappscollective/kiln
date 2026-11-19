<!--
  ListingSections: what the store listing has beyond the texts, per section: categories, age rating,
  privacy choices URL, app details and screenshot and preview counts (Google Play: image counts, app
  details and release notes), each with how it compares with the repository where the repository's
  files can say it. Strictly read-only: values are shown as the store has them, media as counts (never
  images), and nothing here is pulled into the repository or changes a store.
  Props: sections (SectionDrift[] of the drift view), platform, now (ms), storeReadAt (when the store
  listing was last read, or null), schedule and warnings (from the live listing: the scheduled read
  and what the connector noticed), repositoryLinked (the app has a repository to compare with).
-->
<script lang="ts">
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import {
    PLAY_LIMITS_NOTE,
    READ_ONLY_NOTE,
    mediaRows,
    mediaSummary,
    orderedSections,
    releaseNoteRows,
    sectionStatusExplanation,
    sectionStatusLabel,
    sectionStatusTone,
    sectionTitle,
    sectionsSummary,
    valueRows,
  } from '../../lib/listing-sections.ts';
  import type { ListingMedia, ListingReleaseNotes, Platform } from '@mrm/core';
  import type { SectionDrift } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import Section from '../ui/Section.svelte';

  let {
    sections,
    platform,
    now,
    storeReadAt,
    repositoryLinked,
  }: {
    sections: SectionDrift[];
    platform: Platform;
    now: number;
    storeReadAt: number | null;
    repositoryLinked: boolean;
  } = $props();

  const ordered = $derived(orderedSections(sections));
  const summary = $derived(sectionsSummary(sections));
</script>

<section class="sections" aria-labelledby="listing-sections-heading">
  <header class="head">
    <h3 id="listing-sections-heading">Categories, age rating, privacy and media</h3>
    <Badge tone="info" icon="info">Read-only, not pulled into the repository</Badge>
  </header>
  <p class="muted note">
    <Icon name="info" size={14} />
    <span>{READ_ONLY_NOTE}</span>
  </p>
  <p class="summary">
    {summary}{#if storeReadAt !== null}
      <span class="muted"> · store read <time datetime={new Date(storeReadAt).toISOString()} title={fullTime(storeReadAt)}>{timeAgo(storeReadAt, now)}</time></span>
    {/if}
  </p>
  {#if platform === 'android'}
    <p class="muted note"><Icon name="info" size={14} /> <span>{PLAY_LIMITS_NOTE}</span></p>
  {/if}

  {#each ordered as section (section.name)}
    {@const status = section.compare.status}
    <Section
      title={sectionTitle(section.name)}
      key="{platform}.{section.name}"
      level={4}
      flush
      defaultOpen={status === 'differs' || status === 'not-read'}
      summary={`${sectionStatusLabel(status)}${section.name === 'media' && section.store !== null ? ` · ${mediaSummary(section.store as ListingMedia)}` : ''}`}
    >
      {#snippet actions()}
        <Badge tone={sectionStatusTone(status)}>{sectionStatusLabel(status)}</Badge>
        {#if section.name === 'media' && section.store !== null}
          <span class="muted">{mediaSummary(section.store as ListingMedia)}</span>
        {/if}
        {#if section.storeObservedAt !== null}
          <span class="muted when" title={fullTime(section.storeObservedAt)}>in the store since {timeAgo(section.storeObservedAt, now)}</span>
        {/if}
      {/snippet}
      <div class="body">
        <p class="muted explain">{sectionStatusExplanation(status)}</p>
        {#if !repositoryLinked && status !== 'not-read'}
          <p class="muted explain">This app is not linked to a repository, so there is nothing to compare with.</p>
        {/if}
        {#if section.compare.details.length > 0}
          <ul class="details">
            {#each section.compare.details as line (line)}
              <li>{line}</li>
            {/each}
          </ul>
        {/if}

        {#if status === 'not-read'}
          <p class="muted">Not read yet. Refresh from the store to read it.</p>
        {:else if section.name === 'media'}
          {@const rows = mediaRows(
            (section.store ?? undefined) as ListingMedia | undefined,
            (section.repo ?? undefined) as ListingMedia | undefined,
            platform,
          )}
          {#if rows.length === 0}
            <p class="muted">The store has no screenshots, previews or images for this app.</p>
          {:else}
            <div class="table-wrap">
              <table class="compact">
                <caption class="visually-hidden">Screenshot, preview and image counts per locale and device type</caption>
                <thead>
                  <tr>
                    <th scope="col">Locale</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Device type</th>
                    <th scope="col" class="num">Store</th>
                    <th scope="col" class="num">Repository</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rows as row (row.locale + row.kind + row.type)}
                    <tr class:differs={row.differs}>
                      <th scope="row">{row.locale}</th>
                      <td>{row.kind}</td>
                      <td title={row.type}>{row.device}</td>
                      <td class="num">{row.store ?? '–'}</td>
                      <td class="num">
                        {row.repo ?? '–'}
                        {#if row.differs}<Badge tone="warn">Differs</Badge>{/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <p class="muted fine">
              Counts only: no image is read or kept.
              {#if platform !== 'android'}
                The repository's screenshot folders do not say which device a file is for, so only the total of each locale is compared.
              {/if}
            </p>
          {/if}
        {:else if section.name === 'releaseNotes'}
          {@const notes = releaseNoteRows((section.store ?? undefined) as ListingReleaseNotes | undefined)}
          {#if notes.length === 0}
            <p class="muted">No release notes were read.</p>
          {:else}
            {#each notes as track (track.track)}
              <div class="track">
                <h5>{track.track}{#if track.meta}<span class="muted"> · {track.meta}</span>{/if}</h5>
                {#if track.notes.length === 0}
                  <p class="muted">No release notes in this release.</p>
                {:else}
                  <dl>
                    {#each track.notes as note (note.language)}
                      <dt>{note.language}</dt>
                      <dd>{note.text}</dd>
                    {/each}
                  </dl>
                {/if}
              </div>
            {/each}
          {/if}
        {:else}
          {@const rows = valueRows(section.name, section.store, section.repo)}
          {#if rows.length === 0}
            <p class="muted">The store has nothing set here.</p>
          {:else}
            <div class="table-wrap">
              <table class="compact">
                <caption class="visually-hidden">{sectionTitle(section.name)}: the store beside the repository</caption>
                <thead>
                  <tr>
                    <th scope="col">Item</th>
                    <th scope="col">Store</th>
                    <th scope="col">Repository</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rows as row (row.label)}
                    <tr class:differs={row.differs}>
                      <th scope="row" title={row.raw}>{row.label}</th>
                      <td class="value">{row.store ?? '–'}</td>
                      <td class="value">
                        {row.repo ?? '–'}
                        {#if row.differs}<Badge tone="warn">Differs</Badge>{/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if section.repo === null}
              <p class="muted fine">The repository does not say: it has not been read, or its files cannot hold this.</p>
            {/if}
          {/if}
        {/if}
      </div>
    </Section>
  {/each}
</section>

<style>
  .sections {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  .head h3 {
    margin: 0;
    font-size: var(--text-md);
  }

  .note {
    display: flex;
    gap: var(--space-1);
    align-items: flex-start;
    margin: 0;
    font-size: var(--text-sm);
  }

  .summary {
    margin: 0;
    font-weight: var(--weight-medium);
  }

  .when {
    margin-left: auto;
    font-size: var(--text-sm);
  }

  .body {
    padding: 0 var(--space-4) var(--space-4);
  }

  .explain,
  .fine {
    margin: 0 0 var(--space-2);
    font-size: var(--text-sm);
  }

  .details {
    margin: 0 0 var(--space-3);
    padding-left: var(--space-5);
    font-size: var(--text-sm);
  }

  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  .value {
    overflow-wrap: anywhere;
  }

  tr.differs > th,
  tr.differs > td {
    background: var(--surface-sunken);
  }

  .track h5 {
    margin: var(--space-2) 0 var(--space-1);
    font-size: var(--text-sm);
  }

  .track dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: var(--space-1) var(--space-3);
    margin: 0;
    font-size: var(--text-sm);
  }

  .track dd {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
