<!--
  TestBuilds: builds you can try on a device before publishing. The CI artifacts of the runs of one app (zips a workflow uploaded:
  IPA, APK, AAB, Mac builds) and the builds the last store sync saw (TestFlight, Google Play tracks), newest first, with the
  source, size, age and expiry, and what to do to install each one. Downloads go through this server and are off until an
  administrator switches them on; while off, no download button is drawn and the page says why. Nothing here changes GitHub or a store.
  Props: api, workspaceId, role, app, refreshKey (changes when a sync finished, so this reloads).
  The address may carry `?build=<number>` (from the release stepper): that build is highlighted and the filters show it.
-->
<script lang="ts">
  import { type Role, can } from '@mrm/core';
  import { untrack } from 'svelte';
  import { ApiError, type Api } from '../../lib/api.ts';
  import { address } from '../../lib/address.svelte.ts';
  import { parseViewPath } from '../../lib/app-scope.ts';
  import {
    type BuildFilters,
    type BuildRow,
    type BuildsList,
    DOWNLOADS_OFF_TEXT,
    applyFilters,
    defaultFilters,
    downloadBlocker,
    expiryText,
    hiddenBy,
    humanSize,
    installGuide,
    kindLabel,
    problemNotice,
    rowsOf,
    testflightView,
  } from '../../lib/builds.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import PlatformBadge from '../portfolio/PlatformBadge.svelte';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import Skeleton from '../ui/Skeleton.svelte';
  import DownloadDialog from './DownloadDialog.svelte';
  import InstallGuide from './InstallGuide.svelte';
  import PhoneLinkDialog from './PhoneLinkDialog.svelte';
  import TestFlightLinks from './TestFlightLinks.svelte';

  let { api, workspaceId, role, app, refreshKey }: { api: Api; workspaceId: string; role: Role; app: AppSummary; refreshKey: number } = $props();

  const mayRead = $derived(can(role, 'builds.read'));

  let data = $state<BuildsList | null>(null);
  let loading = $state(true);
  let loadProblem = $state('');
  let filters = $state<BuildFilters>({ ...defaultFilters });
  let now = $state(Date.now());
  let downloadRow = $state<BuildRow | null>(null);
  let phoneRow = $state<BuildRow | null>(null);

  const focus = $derived(parseViewPath(address.hash).query.get('build'));
  let generation = 0;

  async function load() {
    const mine = ++generation;
    loading = true;
    loadProblem = '';
    try {
      const read = await api.buildArtifacts(workspaceId, app.id);
      if (mine !== generation) return;
      data = read;
      now = Date.now();
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
    if (mayRead) untrack(() => void load());
  });

  const rows = $derived(data ? rowsOf(data) : []);
  // A build named in the address is always shown, whatever the filters hide.
  const shown = $derived(
    applyFilters(rows, focus ? { ...filters, hideExpired: false, hideOther: false, platform: 'all', source: 'all' } : filters),
  );
  const hidden = $derived(hiddenBy(rows, filters));
  const notice = $derived(data ? problemNotice(data.problem, data.repository) : null);
  const isFocus = (row: BuildRow) => focus !== null && row.store?.buildNumber === focus;
  const platforms = $derived(Array.from(new Set(rows.map((r) => r.platform).filter((p): p is NonNullable<typeof p> => p !== null))));
</script>

<div class="stack">
  <div class="toolbar">
    <p class="muted text-sm">
      Builds to try on a device before you publish: what your CI built, and what the stores hold for testers.
      <InfoTip label="About test builds" width="26rem">
        <p>CI builds are the zips your workflows upload as artifacts. GitHub keeps them for a limited time (90 days unless your workflow or repository says otherwise).</p>
        <p>The type of a CI build (IPA, APK, AAB) is a guess from the artifact name. Store builds come from the last sync of the app.</p>
      </InfoTip>
    </p>
    <Button size="sm" icon="refresh" loading={loading} onclick={() => void load()}>Read again</Button>
  </div>

  {#if !mayRead}
    <Alert tone="info" title="Test builds need the member role">Viewers can see the app and its releases. Ask an admin for the member role to list and download builds.</Alert>
  {:else if loading && !data}
    <div role="status" aria-label="Reading the builds" class="stack">
      <Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" /><Skeleton width="100%" height="2.5rem" />
    </div>
  {:else if loadProblem}
    <Alert tone="error" title="Could not load the builds">
      {loadProblem}
      <div class="retry"><Button size="sm" icon="refresh" onclick={() => void load()}>Try again</Button></div>
    </Alert>
  {:else if data}
    {#if !data.downloadEnabled}
      <Alert tone="info" title="Downloads are switched off">{DOWNLOADS_OFF_TEXT}</Alert>
    {/if}
    {#if notice}
      <Alert tone={notice.tone === 'error' ? 'error' : notice.tone === 'warn' ? 'warn' : 'info'} title={notice.title}>{notice.body}</Alert>
    {/if}

    {#if rows.length > 0}
      <div class="filters" role="group" aria-label="Filter builds">
        <label class="inline">
          <span class="muted text-sm">Platform</span>
          <select bind:value={filters.platform}>
            <option value="all">All</option>
            {#each platforms as p (p)}<option value={p}>{p === 'ios' ? 'iOS' : p === 'macos' ? 'macOS' : 'Android'}</option>{/each}
          </select>
        </label>
        <label class="inline">
          <span class="muted text-sm">Source</span>
          <select bind:value={filters.source}>
            <option value="all">CI and store</option>
            <option value="ci">CI runs</option>
            <option value="store">Store (TestFlight, Play)</option>
          </select>
        </label>
        <label class="inline"><input type="checkbox" bind:checked={filters.hideExpired} /> <span>Hide expired</span></label>
        <label class="inline"><input type="checkbox" bind:checked={filters.hideOther} /> <span>Hide reports and logs</span></label>
        {#if hidden > 0}<span class="muted text-sm" aria-live="polite">{hidden} hidden by the filters</span>{/if}
      </div>
    {/if}

    {#if shown.length === 0}
      <EmptyState icon="smartphone" title={rows.length === 0 ? 'No builds to test yet' : 'Nothing matches the filters'} description={rows.length === 0 ? 'Run a workflow that uploads the build as an artifact (actions/upload-artifact), or sync the app so its store builds appear. CI builds show here for the runs linked to this app.' : 'Change the filters above to see the other builds.'} />
    {:else}
      <div class="table-wrap">
        <table>
          <caption class="visually-hidden">Builds of {app.name} to test</caption>
          <thead>
            <tr>
              <th scope="col">Build</th>
              <th scope="col">Source</th>
              <th scope="col">Size</th>
              <th scope="col">Age</th>
              <th scope="col">State</th>
              <th scope="col"><span class="visually-hidden">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {#each shown as row (row.key)}
              {@const blocker = downloadBlocker(row, data)}
              {@const guide = installGuide(row)}
              <tr class:focus={isFocus(row)} class:faded={row.expired}>
                <td>
                  <div class="cell">
                    <span class="line">
                      {#if row.platform}<PlatformBadge platform={row.platform} showLabel={false} />{/if}
                      <strong class="title">{row.title}</strong>
                      <Badge tone="neutral">{kindLabel(row.kind)}</Badge>
                    </span>
                    {#if row.artifact?.guessed && row.kind !== 'other'}<span class="muted text-sm">Type guessed from the name</span>{/if}
                  </div>
                </td>
                <td>
                  <div class="cell">
                    {#if row.source === 'ci'}
                      <span class="line"><Icon name="pipeline" size={14} /> CI run</span>
                      {#if row.runUrl}
                        <a class="text-sm" href={row.runUrl} target="_blank" rel="noopener noreferrer">{row.detail}<Icon name="external-link" size={12} /><span class="visually-hidden"> (opens in a new tab)</span></a>
                      {:else}<span class="muted text-sm">{row.detail}</span>{/if}
                    {:else}
                      <span class="line"><Icon name="store" size={14} /> Store</span>
                      <span class="muted text-sm">{row.detail}</span>
                      {#if row.store}
                        {@const tf = testflightView(data, row.store)}
                        {#if tf.kind !== 'hidden'}<TestFlightLinks view={tf} />{/if}
                      {/if}
                    {/if}
                  </div>
                </td>
                <td>{humanSize(row.sizeBytes)}</td>
                <td>
                  <div class="cell">
                    {#if row.at !== null}<time datetime={new Date(row.at).toISOString()} title={fullTime(row.at)}>{timeAgo(row.at, now)}</time>{:else}<span class="muted">Unknown</span>{/if}
                    {#if expiryText(row, now) !== ''}<span class="muted text-sm">{expiryText(row, now)}</span>{/if}
                  </div>
                </td>
                <td><Badge tone={row.state.tone === 'neutral' ? 'neutral' : row.state.tone} dot>{row.state.label}</Badge></td>
                <td class="actions">
                  <div class="buttons">
                    {#if row.artifact && blocker === null}
                      <Button size="sm" icon="download" onclick={() => (downloadRow = row)}>Download</Button>
                      {#if guide.qr}<Button size="sm" icon="qr" onclick={() => (phoneRow = row)}>Phone</Button>{/if}
                    {:else if row.artifact}
                      <InfoTip label="Why this cannot be downloaded" icon="lock" text={blocker ?? ''} align="end" />
                    {/if}
                    {#if guide.link}
                      <Button size="sm" icon="external-link" href={guide.link.href} target="_blank">{guide.link.label}</Button>
                    {/if}
                    <InfoTip label="How to install {row.title}" buttonText="Install" icon="smartphone" align="end" width="26rem">
                      <InstallGuide {guide} />
                    </InfoTip>
                  </div>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if data.truncated}<p class="muted text-sm">Only the newest artifacts of the repository were read.</p>{/if}
      {#if data.hiddenArtifacts > 0}<p class="muted text-sm">{data.hiddenArtifacts} other artifact{data.hiddenArtifacts === 1 ? '' : 's'} of this repository belong to other runs or platforms and are not shown.</p>{/if}
    {/if}
  {/if}
</div>

{#if downloadRow && data}
  <DownloadDialog {workspaceId} appId={app.id} row={downloadRow} onclose={() => (downloadRow = null)} />
{/if}
{#if phoneRow && data}
  <PhoneLinkDialog {api} {workspaceId} appId={app.id} row={phoneRow} onclose={() => (phoneRow = null)} />
{/if}

<style>
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
  }

  .toolbar p {
    margin: 0;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    align-items: center;
  }

  .inline {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
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

  .title {
    overflow-wrap: anywhere;
  }

  .actions {
    text-align: right;
  }

  .buttons {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: flex-end;
    align-items: center;
  }

  .faded {
    opacity: 0.7;
  }

  .focus > td {
    background: var(--accent-soft, var(--surface-sunken));
  }

  .retry {
    margin-top: var(--space-2);
  }
</style>
