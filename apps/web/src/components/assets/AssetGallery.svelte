<!--
  AssetGallery: the files of the repository by locale, then by kind and device, in order, with the
  count of each set next to the most the store takes. Each file is a lazy thumbnail (AssetThumb);
  choosing one calls onopen.
  Props: groups (lib/assets.ts groupAssets), workspaceId, appId, commit (the commit of the index, so
  the thumbnails can be cached for good), maxServedBytes (the largest file the route serves),
  problemMap (problems by path), storeSide (the store's counts, or null: then each set says it is
  not yet compared with the store; each file then reads "In repo"), onopen(asset).
  Staging (optional): stageFor (locale, set: what "Stage for store" does for that set, from `setStaging` in
  lib/staged.ts), onstage (locale, set), onunstage (the staged set's id), stagingId (the id of the set being
  staged or unstaged, or ''). Staging changes our own database only; the push is in the staged-changes tray.
-->
<script lang="ts">
  import type { AssetDiffView, AssetProblem } from '@mrm/core';
  import {
    type DeviceGroup,
    type LocaleGroup,
    assetFileUrl,
    compareWithStore,
    countText,
    previewNote,
    previewState,
  } from '../../lib/assets.ts';
  import { storeOnlyCount, storeStatusOf } from '../../lib/assets-groups.ts';
  import { diffBadge, diffSetOf, setIdOf } from '../../lib/assets-sync.ts';
  import { STAGE_ROLE_REASON, type SetStaging } from '../../lib/staged.ts';
  import { toneIcon } from '../../lib/status-icons.ts';
  import type { AssetItem, AssetStoreSide } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import AssetProblems from './AssetProblems.svelte';
  import AssetThumb from './AssetThumb.svelte';

  let {
    groups,
    workspaceId,
    appId,
    commit,
    maxServedBytes,
    problemMap,
    storeSide,
    onopen,
    stageFor,
    onstage,
    onunstage,
    stagingId = '',
    diff = null,
    selected = [],
    ontoggle,
    onedit,
    oncompare,
  }: {
    groups: LocaleGroup[];
    workspaceId: string;
    appId: string;
    commit: string | null;
    maxServedBytes: number;
    problemMap: Record<string, AssetProblem[]>;
    storeSide: AssetStoreSide | null;
    onopen: (asset: AssetItem) => void;
    stageFor?: (locale: string, set: DeviceGroup) => SetStaging;
    onstage?: (locale: string, set: DeviceGroup) => void;
    onunstage?: (id: string, locale: string, set: DeviceGroup) => void;
    stagingId?: string;
    diff?: AssetDiffView | null;
    selected?: string[];
    ontoggle?: (locale: string, set: DeviceGroup) => void;
    onedit?: (locale: string, set: DeviceGroup) => void;
    oncompare?: (locale: string, set: DeviceGroup) => void;
  } = $props();
</script>

<div class="gallery">
  {#each groups as locale (locale.locale)}
    <Section title={locale.label} key="locale.{locale.locale || 'project'}" count={`${locale.assetCount} ${locale.assetCount === 1 ? 'file' : 'files'}`} summary={locale.groups.map((g) => `${g.kindLabel} ${g.count}`).join(' · ')}>
    <div class="locale">
      {#each locale.groups as group (group.key)}
        {@const compare = compareWithStore(storeSide, group, locale.locale)}
        {@const over = group.max !== null && group.count > group.max}
        {@const status = storeStatusOf(compare)}
        {@const storeOnly = storeOnlyCount(compare, group.count)}
        <div class="set">
          <div class="set-head">
            <h4>{group.kindLabel}{group.deviceLabel && group.device !== null ? `: ${group.deviceLabel}` : ''}</h4>
            <span class="count-text">
              <Badge tone={over ? 'bad' : 'neutral'} icon={over ? toneIcon('bad') : undefined}>{countText(group)}</Badge>
            </span>
            <span class="store muted" class:differs={compare.state === 'differs'}>{compare.text}{storeOnly > 0 ? ` (${storeOnly} only in the store)` : ''}</span>
            {#if diff}
              {@const badge = diffBadge(diffSetOf(diff, locale.locale, group.kind, group.device))}
              {#if badge}<Badge tone={badge.tone}>{badge.text}</Badge>{/if}
            {/if}
            {#if ontoggle}
              <label class="pick">
                <input type="checkbox" checked={selected.indexOf(setIdOf(locale.locale, group.kind, group.device)) !== -1} onchange={() => ontoggle?.(locale.locale, group)} />
                <span>Select<span class="visually-hidden"> {group.kindLabel} {group.deviceLabel}, {locale.label}</span></span>
              </label>
            {/if}
          </div>
          {#if stageFor}
            {@const st = stageFor(locale.locale, group)}
            <div class="stage-row">
              {#if st.staged}
                <Badge tone="accent" icon="layers">{st.stagedState === 'current' ? 'Staged' : 'Staged: the repository files changed since'}</Badge>
                {#if st.staged.pushed}<Badge tone="ok" icon="check">In the store draft</Badge>{/if}
              {/if}
              <Button
                size="sm"
                icon="layers"
                loading={stagingId === st.id}
                disabled={!st.canStage || stagingId !== '' || st.stagedState === 'current'}
                title={st.reason ?? undefined}
                onclick={() => onstage?.(locale.locale, group)}
              >{st.stagedState === 'current' ? 'Staged for store' : st.staged ? 'Stage again' : 'Stage for store'}<span class="visually-hidden">: {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>
              {#if st.staged}
                <Button size="sm" variant="ghost" icon="x" disabled={stagingId !== ''} onclick={() => st.staged && onunstage?.(st.staged.id, locale.locale, group)}>Unstage<span class="visually-hidden"> {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>
              {/if}
              {#if onedit}<Button size="sm" variant="ghost" icon="image" onclick={() => onedit?.(locale.locale, group)}>Edit files<span class="visually-hidden">: {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>{/if}
              {#if oncompare}<Button size="sm" variant="ghost" icon="eye" onclick={() => oncompare?.(locale.locale, group)}>Compare with the store<span class="visually-hidden">: {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>{/if}
              {#if !st.canStage && st.reason && st.reason !== STAGE_ROLE_REASON}
                <span class="muted why">{st.reason}</span>
              {/if}
            </div>
          {/if}
          {#if !stageFor && (onedit || oncompare)}
            <div class="stage-row">
              {#if onedit}<Button size="sm" variant="ghost" icon="image" onclick={() => onedit?.(locale.locale, group)}>Edit files<span class="visually-hidden">: {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>{/if}
              {#if oncompare}<Button size="sm" variant="ghost" icon="eye" onclick={() => oncompare?.(locale.locale, group)}>Compare with the store<span class="visually-hidden">: {group.kindLabel} {group.deviceLabel}, {locale.label}</span></Button>{/if}
            </div>
          {/if}
          {#if group.setProblems.length > 0}
            <AssetProblems problems={group.setProblems} showPath={false} />
          {/if}
          <ul class="grid" aria-label="{group.kindLabel}, {group.deviceLabel}, {locale.label}">
            {#each group.assets as asset (asset.path)}
              {@const kind = previewState(asset, maxServedBytes)}
              <AssetThumb
                {asset}
                preview={kind}
                src={kind === 'image' ? assetFileUrl(workspaceId, appId, asset.path, commit) : null}
                note={previewNote(kind, maxServedBytes)}
                problems={problemMap[asset.path] ?? []}
                store={status}
                onopen={() => onopen(asset)}
              />
            {/each}
          </ul>
        </div>
      {/each}
    </div>
    </Section>
  {/each}
</div>

<style>
  .gallery {
    display: grid;
    gap: var(--space-4);
  }
  .locale {
    display: grid;
    gap: var(--space-4);
  }
  h4 {
    margin: 0;
    font-size: var(--text-md);
  }
  .set {
    display: grid;
    gap: var(--space-3);
  }
  .set-head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .store {
    font-size: var(--text-sm);
  }
  .stage-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  .why {
    font-size: var(--text-sm);
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    margin-left: auto;
    font-size: var(--text-sm);
  }
  .store.differs {
    color: var(--warn-ink);
  }
  .grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--space-3);
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
</style>
