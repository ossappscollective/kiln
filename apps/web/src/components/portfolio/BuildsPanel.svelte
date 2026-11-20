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
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
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
  const now = $derived.by(() => {
    void data;
    return Date.now();
  });

  let generation = 0;

  const keyOf = (build: Pick<AppBuild, 'platform' | 'buildNumber'>) => `${build.platform}:${build.buildNumber}`;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await api.appBuilds(workspaceId, app.id);
      if (mine !== generation) return;
      data = read;
    } catch (e) {
      if (mine !== generation) return;
      data = null;
      loadProblem = e instanceof ApiError ? e.message : 'Could not load the builds.';
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
      toast.success(`Removed the link of ${buildName(build)}.`);
      announcement = `Removed the link of build ${build.buildNumber}.`;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Could not remove the link.');
    } finally {
      unlinking = '';
    }
  }

  function linked(updated: AppBuild) {
    if (!linkTarget) return;
    replace(updated, linkTarget);
    announcement = `Linked build ${updated.buildNumber}.`;
  }

  const unlinkedCount = $derived(data?.builds.filter((b) => b.linkState === 'unlinked').length ?? 0);
  const lead = $derived(buildsLead(data?.builds.length ?? 0, unlinkedCount));
  const tagOnlyCount = $derived(data?.builds.filter((b) => b.linkState === 'tag').length ?? 0);
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
      const linkedNow = rest.builds.filter((b) => b.linkState !== 'unlinked').length;
      if (result.error) {
        toast.error(`Matching could not read the tags: ${result.error}`);
        announcement = 'Matching could not read the tags.';
      } else if (!quiet) {
        toast.success(
          result.scanned
            ? `Matched again: ${linkedNow} of ${rest.builds.length} builds have a link or a tag.`
            : 'Every build already has a settled link, so nothing was searched.',
        );
        announcement = `Matched again. ${linkedNow} of ${rest.builds.length} builds have a link or a tag.`;
      } else {
        announcement = `Searched the tags: ${linkedNow} of ${rest.builds.length} builds have a link or a tag.`;
      }
    } catch (e) {
      if (!quiet) toast.error(e instanceof ApiError ? e.message : 'Could not match the builds.');
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
      unlinked: read.builds.filter((b) => b.linkState === 'unlinked').length,
      alreadyTried: autoTried.has(app.id),
    });
    if (!go) return;
    autoTried.add(app.id);
    untrack(() => void rematch(true));
  });

  function conventionsSaved(result: { rematch: boolean }) {
    if (result.rematch && canMatch) void rematch();
    else void load();
  }

  const tagLinkOf = (link: BuildLink | null) => (link && link.state === 'tag' ? link : null);
</script>

<div class="stack loose" aria-busy={loading}>
  <p class="visually-hidden" role="status">{announcement}</p>

  {#if loading && !data}
    <div class="card" role="status" aria-label="Loading the builds">
      <div class="stack">
        <Skeleton width="70%" height="16px" />
        <Skeleton width="55%" height="16px" />
        <Skeleton width="62%" height="16px" />
      </div>
    </div>
  {:else if loadProblem}
    <div class="stack">
      <Alert tone="error" title="Could not load the builds">{loadProblem}</Alert>
      <div><Button icon="refresh" onclick={load}>Try again</Button></div>
    </div>
  {:else if data}
    {#if data.builds.length === 0}
      <div class="card">
        <EmptyState
          icon="box"
          title="No builds yet"
          description="Builds come from the store. Sync the app to read its iOS builds or Android version codes."
        />
      </div>
    {:else}
      <PageLead
        testid="builds-lead"
        tone={lead.tone}
        headline={lead.headline}
        hint={data.repository
          ? data.diagnostics?.scannedAt
            ? `Tags and releases were last searched ${timeAgo(data.diagnostics.scannedAt, now)}.`
            : 'Tags and releases have not been searched yet.'
          : 'No repository is linked, so builds cannot be matched to CI runs. These come from the last store sync.'}
      >
        {#snippet actions()}
          {#if data?.repository}
            {#if canMatch}
              <Button icon="refresh" loading={rematching} onclick={() => rematch()}>Re-run matching</Button>
            {/if}
            <Button variant="ghost" icon="settings" onclick={() => (conventionsOpen = true)}>Build number conventions</Button>
          {/if}
        {/snippet}
      </PageLead>

      <Section title="Builds" key="builds" count={data.builds.length} flush>
      <div class="table-wrap">
        <table>
          <caption class="visually-hidden">Builds of {app.name}</caption>
          <thead>
            <tr>
              <th scope="col">Build</th>
              <th scope="col">In the store</th>
              <th scope="col">CI run</th>
              <th scope="col">Commit</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
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
                    {#if build.tracks.length > 0}<span class="muted text-sm">{build.tracks.join(', ')}</span>{/if}
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <ReleaseStatus status={build.status} rawState={build.rawState} />
                    {#if build.uploadedAt !== null}
                      <span class="muted text-sm"
                        >Uploaded <time datetime={new Date(build.uploadedAt).toISOString()} title={fullTime(build.uploadedAt)}>{timeAgo(build.uploadedAt, now)}</time></span
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
                          <summary>Why this tag</summary>
                          <p class="muted text-sm">{link.evidence.reason}</p>
                          <p class="muted text-sm">Pattern <code>{link.evidence.pattern}</code></p>
                        </details>
                      {/if}
                    </div>
                  {:else if link}
                    <div class="cell">
                      {#if link.run}
                        <span class="line">
                          {#if link.run.status !== 'unknown'}<RunStatus run={link.run} />{/if}
                          {#if link.run.url}
                            <a href={link.run.url} target="_blank" rel="noopener noreferrer"
                              >Run {link.run.id}<Icon name="external-link" size={14} /><span class="visually-hidden"> on GitHub (opens in a new tab)</span></a
                            >
                          {:else}
                            <span>Run {link.run.id}</span>
                          {/if}
                        </span>
                        {#if link.run.workflow}<span class="muted text-sm">{link.run.workflow}</span>{/if}
                      {:else}
                        <span class="muted">The run is no longer stored.</span>
                      {/if}
                      <span class="muted text-sm" title={link.reason}>{linkSourceLabel(link.source)}</span>
                      {#if link.source === 'tag' || link.source === 'release'}
                        {@const confidence = confidenceBadge(link.confidence)}
                        <span class="line"><Badge tone={confidence.tone}>{confidence.label}</Badge></span>
                        {#if isUncertain(link)}
                          <span class="muted text-sm">Several runs could have made this build. Link the right one by hand if this is wrong.</span>
                        {/if}
                        {#if link.evidence}
                          <details class="evidence">
                            <summary>Why this run</summary>
                            <p class="muted text-sm">{link.evidence.reason}</p>
                            <p class="muted text-sm">
                              {link.evidence.kind === 'release' ? 'Release' : 'Tag'} <code>{link.evidence.tag}</code>, pattern <code>{link.evidence.pattern}</code>
                            </p>
                          </details>
                        {/if}
                      {/if}
                    </div>
                  {:else}
                    <div class="cell">
                      <Badge tone="warn">Unlinked</Badge>
                      <span class="muted text-sm"
                        >{build.diagnostic?.message ?? `No CI run with build number ${build.buildNumber} was found.`}</span
                      >
                    </div>
                  {/if}
                </td>
                <td>
                  {#if link?.commit}
                    <div class="cell">
                      {#if link.commit.url}
                        <a href={link.commit.url} target="_blank" rel="noopener noreferrer"
                          ><code>{link.commit.shortSha}</code><span class="visually-hidden"> on GitHub (opens in a new tab)</span></a
                        >
                      {:else}
                        <code>{shortSha(link.commit.sha)}</code>
                      {/if}
                      {#if link.commit.message}<span class="muted text-sm">{link.commit.message}</span>{/if}
                    </div>
                  {:else}
                    <span class="muted">None</span>
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
                        onclick={() => (open = { ...open, [key]: !open[key] })}>What changed</Button
                      >
                    {/if}
                    {#if canLink && data.repository}
                      <Button size="sm" icon="git-branch" onclick={() => (linkTarget = build)}>{link?.manual ? 'Change link' : 'Link'}</Button>
                      {#if link?.manual}
                        <Button size="sm" variant="ghost" icon="x" loading={unlinking === key} onclick={() => unlink(build)}
                          >Remove link<span class="visually-hidden"> of build {build.buildNumber}</span></Button
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
        <summary>How builds are matched to runs</summary>
        <p class="muted">
          A build is matched to a run by its number, never by guessing. {#if unlinkedCount > 0}{unlinkedCount} of {data.builds.length}
            {unlinkedCount === 1 ? 'build is' : 'builds are'} unlinked.{/if}
          {#if tagOnlyCount > 0}{tagOnlyCount} {tagOnlyCount === 1 ? 'build has' : 'builds have'} a tag but no run yet.{/if} The matchers, in order:
        </p>
        <ul>
          {#each data.matchers as matcher (matcher.id)}
            <li><code>{matcher.id}</code>: {matcher.description}</li>
          {/each}
          <li>
            <code>tag</code>: the build number is in a tag or GitHub release name (such as <code>ios/appstore/1.2.3/123</code>); the tag's commit leads to the run that made it.
          </li>
        </ul>
        {#if canLink}<p class="muted">A build that nothing finds can be linked to a run by hand.</p>{/if}

        {#if data.diagnostics}
          {@const d = data.diagnostics}
          <h3 class="diag-title">What was searched</h3>
          <ul>
            {#each diagnosticsLines(d) as line (line)}<li>{line}</li>{/each}
          </ul>
          <p class="muted">
            Patterns in use: {conventionSourceLabel(d.patterns)}{d.patterns.prefix ? `, prefix ${d.patterns.prefix}` : ''}{d.patterns.workflow ? `, workflow ${d.patterns.workflow}` : ''}.
            {#if d.tags && d.tags.sample.length > 0}Some of the tags read: {#each d.tags.sample.slice(0, 5) as tag, i (tag)}{#if i > 0}, {/if}<code>{tag}</code>{/each}.{/if}
          </p>
          <div>
            <Button size="sm" icon="settings" onclick={() => (conventionsOpen = true)}>Build number conventions</Button>
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
