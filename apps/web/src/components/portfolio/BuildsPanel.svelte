<!--
  BuildsPanel: the builds of one app and the CI runs that made them. Each row is a build the store
  reported (an iOS build number, or an Android version code) with its state in the store, the CI run
  it was matched to (or "Unlinked"), the commit, and a "What changed" expander that lists the
  commits since the previous linked build. Reading is open to everyone who can see the app; linking
  by hand needs the right to sync, and "What changed" reads GitHub, which needs the right of a scan.
  A build whose run was not found says why (what was searched), can be searched again ("Re-run
  matching", a scan right), and the patterns that read build numbers from tags and releases are
  edited in "Build number conventions". A build whose tag was found but whose run was not is "Tag
  found". Nothing here builds or publishes: runs are started from the repository's CI tab.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished, so this reloads).
-->
<script lang="ts">
  import T from '../ui/T.svelte';
  import { t } from '../../lib/i18n/t.ts';
  import { formatList } from '../../lib/i18n/format.ts';
  import { type Role, can } from '@kiln/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { releaseFactsStore } from '../../lib/app-state/release-facts-store.svelte.ts';
  import {
    buildLinkLabel,
    buildName,
    buildNumberLabel,
    confidenceBadge,
    conventionSourceLabel,
    diagnosticsLines,
    isUncertain,
    linkSourceLabel,
    shortSha,
    buildLinkCounts,
    shouldAutoRematch,
    tagFoundText,
  } from '../../lib/ci/ci.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import { buildsLead } from '../../lib/page-lead.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppBuild, AppBuilds, AppSummary, BuildLink } from '../../lib/types.ts';
  import RunStatus from '../ci/RunStatus.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import StoreBadge from '../ui/StoreBadge.svelte';
  import BuildsPanelChanges from './BuildsPanelChanges.svelte';
  import BuildsPanelConventions from './BuildsPanelConventions.svelte';
  import BuildsPanelLink from './BuildsPanelLink.svelte';
  import PlatformBadge from './PlatformBadge.svelte';
  import PageLead from '../ui/PageLead.svelte';
  import Section from '../ui/Section.svelte';
  import ReleaseStatus from './ReleaseStatus.svelte';
  import { useNow } from '../../lib/app-state/clock.svelte.ts';

  let {
    api,
    workspaceId,
    role,
    app,
    refreshKey,
  }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const canLink = $derived(can(role, 'apps.sync'));
  const canRead = $derived(can(role, 'repositories.scan'));
  const canMatch = $derived(can(role, 'repositories.scan'));

  let data = $state<AppBuilds | null>(null);
  let loading = $state(true);
  let loadProblem = $state('');
  let open = $state<Record<string, boolean>>({});
  let linkTarget = $state<AppBuild | null>(null);
  let unlinking = $state('');
  let rematching = $state(false);
  let conventionsOpen = $state(false);
  /** Apps whose first automatic search was tried, so a failed one is not repeated by itself. */
  const autoTried = new Set<string>();
  let announcement = $state('');
  const clock = useNow({ everyMs: 30_000 });
  const now = $derived(clock.value);

  let generation = 0;

  const hasTracks = (build: Pick<AppBuild, 'tracks'>) => build.tracks.length > 0;
  const keyOf = (build: Pick<AppBuild, 'platform' | 'buildNumber'>) => `${build.platform}:${build.buildNumber}`;

  async function load(force = false) {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await releaseFactsStore.readAppBuilds(api, workspaceId, app.id, { force });
      if (mine !== generation) return;
      data = read;
      clock.touch();
    } catch (e) {
      if (mine !== generation) return;
      data = null;
      loadProblem = e instanceof ApiError ? e.message : t('portfolio:builds.loadFailed');
    } finally {
      if (mine === generation) loading = false;
    }
  }

  $effect(() => {
    void app.id;
    void workspaceId;
    void refreshKey;
    untrack(() => void load());
  });

  /** Puts one updated build into the table without reloading the rest. */
  function replace(updated: AppBuild | null, original: AppBuild) {
    if (!data) return;
    const key = keyOf(original);
    data = { ...data, builds: data.builds.map((b) => (keyOf(b) === key ? (updated ?? b) : b)) };
    // A new link means a new commit: what changed has to be read again.
    open = { ...open, [key]: false };
  }

  async function unlink(build: AppBuild) {
    unlinking = keyOf(build);
    try {
      const done = await api.unlinkBuild(workspaceId, app.id, build);
      replace(done.build, build);
      toast.success(t('portfolio:builds.unlinked', { name: buildName(build) }));
      announcement = t('portfolio:builds.unlinkedAnnounce', { build: build.buildNumber });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : t('portfolio:builds.unlinkFailed'));
    } finally {
      unlinking = '';
    }
  }

  function linked(updated: AppBuild) {
    if (!linkTarget) return;
    replace(updated, linkTarget);
    announcement = t('portfolio:builds.linkedAnnounce', { build: updated.buildNumber });
  }

  const links = $derived(buildLinkCounts(data?.builds ?? []));
  const unlinkedCount = $derived(links.unlinked);
  const lead = $derived(buildsLead(links.all, links.unlinked));
  const tagOnlyCount = $derived(links.tagOnly);
  /** The newest build without a run: what the conventions dialog takes its example number from. */
  const exampleBuild = $derived(
    data?.builds.find((b) => b.linkState === 'unlinked' && b.platform === app.platform) ?? data?.builds.find((b) => b.platform === app.platform) ?? null,
  );

  /** Reads the runs, tags and releases again and matches this app's builds. `quiet` is the automatic first try. */
  async function rematch(quiet = false) {
    if (rematching) return;
    rematching = true;
    try {
      const done = await api.rematchBuilds(workspaceId, app.id);
      const { rematch: result, ...rest } = done;
      data = rest;
      open = {};
      const after = buildLinkCounts(rest.builds);
      const linkedNow = after.linked;
      if (result.error) {
        toast.error(t('portfolio:builds.matchTagsFailed', { error: result.error }));
        announcement = t('portfolio:builds.matchTagsFailedAnnounce');
      } else if (!quiet) {
        toast.success(
          result.scanned
            ? t('portfolio:builds.matchedAgain', { count: after.all, linked: linkedNow })
            : t('portfolio:builds.nothingSearched'),
        );
        announcement = t('portfolio:builds.matchedAgainAnnounce', { count: after.all, linked: linkedNow });
      } else {
        announcement = t('portfolio:builds.searchedTags', { count: after.all, linked: linkedNow });
      }
    } catch (e) {
      if (!quiet) toast.error(e instanceof ApiError ? e.message : t('portfolio:builds.matchFailed'));
    } finally {
      rematching = false;
    }
  }

  // The first time a repository's tags were never searched, search by itself, once per app.
  $effect(() => {
    const read = data;
    if (!read || loading) return;
    const go = shouldAutoRematch({
      hasRepository: read.repository !== null,
      canScan: canMatch,
      diagnostics: read.diagnostics,
      unlinked: buildLinkCounts(read.builds).unlinked,
      alreadyTried: autoTried.has(app.id),
    });
    if (!go) return;
    autoTried.add(app.id);
    untrack(() => void rematch(true));
  });

  function conventionsSaved(result: { rematch: boolean }) {
    if (result.rematch && canMatch) void rematch();
    else void load(true);
  }

  const tagLinkOf = (link: BuildLink | null) => (link && link.state === 'tag' ? link : null);
</script>

<div class="stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !data}
    <div class="card" role="status" aria-label={t('portfolio:builds.loading')}>
      <div class="stack">
        <Skeleton width="70%" height="16px" />
        <Skeleton width="55%" height="16px" />
        <Skeleton width="62%" height="16px" />
      </div>
    </div>
  {:else if loadProblem}
    <div class="stack">
      <Alert tone="error" title={t('portfolio:builds.loadFailed')}>{loadProblem}</Alert>
      <div><Button icon="refresh" onclick={load}>{t('common:action.tryAgain')}</Button></div>
    </div>
  {:else if data}
    {#if links.all === 0}
      <div class="card">
        <EmptyState
          icon="box"
          title={t('portfolio:builds.emptyTitle')}
          description={t('portfolio:builds.emptyHelp')}
        />
      </div>
    {:else}
      <PageLead
        testid="builds-lead"
        tone={lead.tone}
        headline={lead.headline}
        hint={data.repository
          ? data.diagnostics?.scannedAt
            ? t('portfolio:builds.searchedAt', { when: timeAgo(data.diagnostics.scannedAt, now) })
            : t('portfolio:builds.notSearched')
          : t('portfolio:builds.noRepository')}
      >
        {#snippet actions()}
          {#if data?.repository}
            {#if canMatch}
              <Button icon="refresh" loading={rematching} onclick={() => rematch()}>{t('portfolio:builds.rerun')}</Button>
            {/if}
            <Button variant="ghost" icon="settings" onclick={() => (conventionsOpen = true)}>{t('portfolio:builds.conventions')}</Button>
          {/if}
        {/snippet}
      </PageLead>

      <Section title={t('app:nav.builds')} key="builds" count={links.all} flush>
      <div class="table-wrap">
        <table>
          <caption class="visually-hidden">{t('portfolio:builds.caption', { name: app.name })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('portfolio:release.build')}</th>
              <th scope="col">{t('portfolio:builds.inStore')}</th>
              <th scope="col">{t('portfolio:builds.ciRun')}</th>
              <th scope="col">{t('portfolio:builds.commit')}</th>
              <th scope="col"><span class="visually-hidden">{t('portfolio:table.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {#each data.builds as build (keyOf(build))}
              {@const key = keyOf(build)}
              {@const link = build.link}
              <tr>
                <td>
                  <div class="cell">
                    <span class="line"><PlatformBadge platform={build.platform} /> <strong>{build.version}</strong></span>
                    <span class="muted text-sm">{buildNumberLabel(build.platform)} <code>{build.buildNumber}</code></span>
                    {#if hasTracks(build)}<span class="muted text-sm">{build.tracks.join(', ')}</span>{/if}
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <ReleaseStatus status={build.status} rawState={build.rawState} />
                    {#if build.uploadedAt !== null}
                      <span class="muted text-sm"
                        >{t('portfolio:builds.uploaded')} <time datetime={new Date(build.uploadedAt).toISOString()} title={fullTime(build.uploadedAt)}>{timeAgo(build.uploadedAt, now)}</time></span
                      >
                    {/if}
                  </div>
                </td>
                <td>
                  {#if link && tagLinkOf(link)}
                    <div class="cell">
                      <span class="tag-source"><StoreBadge store="github" variant="icon" size="sm" /><Badge tone="info" icon="link">{buildLinkLabel(build)}</Badge></span>
                      <span class="text-sm">{tagFoundText(link)}</span>
                      {#if link.evidence}
                        <details class="evidence">
                          <summary>{t('portfolio:builds.whyTag')}</summary>
                          <p class="muted text-sm">{link.evidence.reason}</p>
                          <p class="muted text-sm"><T key="portfolio:builds.pattern" params={{ pattern: link.evidence.pattern }} /></p>
                        </details>
                      {/if}
                    </div>
                  {:else if link}
                    <div class="cell">
                      {#if link.run}
                        <span class="line">
                          {#if link.run.status !== 'unknown'}<RunStatus run={link.run} />{/if}
                          {#if link.run.url}
                            <a href={link.run.url} target="_blank" rel="noopener noreferrer" aria-label={t('portfolio:builds.runOnGithub', { id: link.run.id })}
                              >{t('portfolio:builds.run', { id: link.run.id })}<Icon name="external-link" size={14} /></a
                            >
                          {:else}
                            <span>{t('portfolio:builds.run', { id: link.run.id })}</span>
                          {/if}
                        </span>
                        {#if link.run.workflow}<span class="muted text-sm">{link.run.workflow}</span>{/if}
                      {:else}
                        <span class="muted">{t('portfolio:builds.runGone')}</span>
                      {/if}
                      <span class="muted text-sm" title={link.reason}>{linkSourceLabel(link.source)}</span>
                      {#if link.source === 'tag' || link.source === 'release'}
                        {@const confidence = confidenceBadge(link.confidence)}
                        <span class="line"><Badge tone={confidence.tone}>{confidence.label}</Badge></span>
                        {#if isUncertain(link)}
                          <span class="muted text-sm">{t('portfolio:builds.uncertain')}</span>
                        {/if}
                        {#if link.evidence}
                          <details class="evidence">
                            <summary>{t('portfolio:builds.whyRun')}</summary>
                            <p class="muted text-sm">{link.evidence.reason}</p>
                            <p class="muted text-sm">
                              {#if link.evidence.kind === 'release'}<T key="portfolio:builds.evidenceRelease" params={{ tag: link.evidence.tag, pattern: link.evidence.pattern }} />{:else}<T key="portfolio:builds.evidenceTag" params={{ tag: link.evidence.tag, pattern: link.evidence.pattern }} />{/if}
                            </p>
                          </details>
                        {/if}
                      {/if}
                    </div>
                  {:else}
                    <div class="cell">
                      <Badge tone="warn">{t('portfolio:builds.unlinkedBadge')}</Badge>
                      <span class="muted text-sm"
                        >{build.diagnostic?.message ?? t('portfolio:builds.noRun', { build: build.buildNumber })}</span
                      >
                    </div>
                  {/if}
                </td>
                <td>
                  {#if link?.commit}
                    <div class="cell">
                      {#if link.commit.url}
                        <a href={link.commit.url} target="_blank" rel="noopener noreferrer" aria-label={t('portfolio:builds.commitOnGithub', { sha: link.commit.shortSha })}
                          ><code>{link.commit.shortSha}</code></a
                        >
                      {:else}
                        <code>{shortSha(link.commit.sha)}</code>
                      {/if}
                      {#if link.commit.message}<span class="muted text-sm">{link.commit.message}</span>{/if}
                    </div>
                  {:else}
                    <span class="muted">{t('portfolio:overviewTable.none')}</span>
                  {/if}
                </td>
                <td class="actions">
                  <div class="buttons">
                    {#if canRead && link?.commit}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={open[key] ? 'chevron-up' : 'chevron-down'}
                        aria-expanded={open[key] ? 'true' : 'false'}
                        aria-controls="changes-{key.replace(':', '-')}"
                        onclick={() => (open = { ...open, [key]: !open[key] })}>{t('portfolio:builds.whatChanged')}</Button
                      >
                    {/if}
                    {#if canLink && data.repository}
                      <Button size="sm" icon="git-branch" onclick={() => (linkTarget = build)}>{link?.manual ? t('portfolio:builds.changeLink') : t('portfolio:builds.link')}</Button>
                      {#if link?.manual}
                        <Button size="sm" variant="ghost" icon="x" loading={unlinking === key} onclick={() => unlink(build)}
                           label={t('portfolio:builds.removeLinkOf', { build: build.buildNumber })}>{t('portfolio:builds.removeLink')}</Button
                        >
                      {/if}
                    {/if}
                  </div>
                </td>
              </tr>
              {#if open[key] && canRead && link?.commit}
                <tr class="expanded">
                  <td colspan="5" id="changes-{key.replace(':', '-')}">
                    <BuildsPanelChanges {api} {workspaceId} appId={app.id} {build} />
                  </td>
                </tr>
              {/if}
            {/each}
          </tbody>
        </table>
      </div>
      </Section>

      <details class="how">
        <summary>{t('portfolio:builds.how')}</summary>
        <p class="muted">
          {t('portfolio:builds.howIntro')}
          {#if unlinkedCount > 0}{t('portfolio:builds.howUnlinked', { count: unlinkedCount, total: links.all })}{/if}
          {#if tagOnlyCount > 0}{t('portfolio:builds.howTagOnly', { count: tagOnlyCount })}{/if}
          {t('portfolio:builds.howMatchers')}
        </p>
        <ul>
          {#each data.matchers as matcher (matcher.id)}
            <li><code>{matcher.id}</code>: {matcher.description}</li>
          {/each}
          <li>
            <T key="portfolio:builds.tagMatcher" />
          </li>
        </ul>
        {#if canLink}<p class="muted">{t('portfolio:builds.howManual')}</p>{/if}

        {#if data.diagnostics}
          {@const d = data.diagnostics}
          <h3 class="diag-title">{t('portfolio:builds.searched')}</h3>
          <ul>
            {#each diagnosticsLines(d) as line (line)}<li>{line}</li>{/each}
          </ul>
          <p class="muted">
            {t('portfolio:builds.patternsInUse', { list: formatList([conventionSourceLabel(d.patterns), ...(d.patterns.prefix ? [t('portfolio:builds.prefix', { prefix: d.patterns.prefix })] : []), ...(d.patterns.workflow ? [t('portfolio:builds.workflow', { workflow: d.patterns.workflow })] : [])], { type: 'unit' }) })}
            {#if d.tags && d.tags.sample.length > 0}{t('portfolio:builds.someTags')} {#each d.tags.sample.slice(0, 5) as tag, i (tag)}{#if i > 0}, {/if}<code>{tag}</code>{/each}.{/if}
          </p>
          <div>
            <Button size="sm" icon="settings" onclick={() => (conventionsOpen = true)}>{t('portfolio:builds.conventions')}</Button>
          </div>
        {/if}
      </details>
    {/if}
  {/if}
</div>

{#if conventionsOpen && data?.repository}
  <BuildsPanelConventions
    {api}
    {workspaceId}
    {role}
    repository={data.repository}
    {app}
    build={exampleBuild}
    onclose={() => (conventionsOpen = false)}
    onsaved={conventionsSaved}
  />
{/if}

{#if linkTarget && data?.repository}
  <BuildsPanelLink
    {api}
    {workspaceId}
    appId={app.id}
    repository={data.repository}
    build={linkTarget}
    onclose={() => (linkTarget = null)}
    onlinked={linked}
  />
{/if}

<style>
  .tag-source {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .line {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }

  .actions {
    text-align: right;
  }

  .buttons {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
  }

  .expanded > td {
    background: var(--surface-sunken);
  }

  .evidence {
    font-size: var(--text-sm);
  }

  .evidence summary {
    cursor: pointer;
  }

  .diag-title {
    margin: var(--space-3) 0 var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  table {
    font-size: 0.9375rem;
  }

  .cell .text-sm {
    font-size: var(--text-base);
  }

  .how {
    font-size: 0.9375rem;
  }

  .how summary {
    cursor: pointer;
    font-weight: var(--weight-medium);
  }
</style>
