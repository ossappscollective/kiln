<!--
  ReleaseTable: the compact releases table, one block per version: version, platform, build, status,
  rollout share, date, CI and plan state on one dense row. A row opens (chevron) to its store and plan
  detail. The version links to the full release page.
  Props: api, workspaceId, role, groups (from buildReleaseTable), apps (the platform records in scope,
  by id), builds (by app id; an app without an entry has no CI data), now, scope (the platform scope
  for links), showPlatform (true when more than one platform is in scope).
  A Google Play release in a track that is not production, serving users, gets a "Promote to production" link in its platform cell
  and a button in its details: it opens Prepare release with the track and the version codes filled in (lib/play-promote.ts).
-->
<script lang="ts">
  import { can, type Role, supports } from '@kiln/core';
  import type { Api } from '../../lib/api.ts';
  import { type PlatformScope, appAddress } from '../../lib/app-scope.ts';
  import { promoteHref, promoteOption } from '../../lib/play-promote.ts';
  import { formatDate, formatDateTime, formatList, formatRelativeTime } from '../../lib/i18n/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import { platformLabel } from '../../lib/portfolio.ts';
  import type { VersionGroup } from '../../lib/releases-table.ts';
  import type { AppBuild, AppSummary } from '../../lib/types.ts';
  import { PLANS_ENABLED } from '../../lib/features.ts';
  import ReleaseRowDetail from './ReleaseRowDetail.svelte';
  import ReleaseStatus from '../portfolio/ReleaseStatus.svelte';
  import Badge from '../ui/Badge.svelte';
  import Icon from '../ui/Icon.svelte';
  import PlatformBadge from '../ui/PlatformBadge.svelte';

  let {
    api,
    workspaceId,
    role,
    groups,
    apps,
    builds,
    now,
    scope,
    showPlatform,
  }: {
    api: Api;
    workspaceId: string;
    role: Role;
    groups: VersionGroup[];
    apps: Record<string, AppSummary | undefined>;
    builds: Record<string, readonly AppBuild[] | undefined>;
    now: number;
    scope: PlatformScope | null;
    showPlatform: boolean;
  } = $props();

  const uid = $props.id();
  const columns = PLANS_ENABLED ? 9 : 8;

  const canPrepare = $derived(can(role, 'listing.read'));
  let open = $state<Set<string>>(new Set());

  function toggle(key: string) {
    const next = new Set(open);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    open = next;
  }

  const rowName = (row: { platform: Parameters<typeof platformLabel>[0]; version: string; track: string | null; trackText: string }): string =>
    row.track ? t('release:rt.rowNameTrack', { platform: platformLabel(row.platform), version: row.version, track: row.trackText }) : t('release:rt.rowName', { platform: platformLabel(row.platform), version: row.version });

  function dateTitle(at: number, source: string | null, platform: Parameters<typeof supports>[0]): string {
    const params = { when: formatDateTime(at), ago: formatRelativeTime(at, { now }) };
    if (source === 'seen') return t('release:rt.dateSeen', params);
    return supports(platform, 'releaseTracks') ? t('release:rt.dateTitle', params) : t('release:rt.dateBuild', params);
  }
</script>

<div class="card flush table-scroll">
  <table class="releases compact">
    <caption class="visually-hidden">
      {showPlatform ? t('release:rt.captionPlatform') : t('release:rt.caption')}
    </caption>
    <thead>
      <tr>
        <th scope="col" class="expander"><span class="visually-hidden">{t('release:rt.details')}</span></th>
        <th scope="col">{t('release:rt.version')}</th>
        <th scope="col">{t('release:rt.platform')}</th>
        <th scope="col">{t('release:rt.build')}</th>
        <th scope="col">{t('release:rt.status')}</th>
        <th scope="col" class="num">{t('release:rt.rollout')}</th>
        <th scope="col" title={t('release:rt.dateHint')}>{t('release:rt.date')}</th>
        <th scope="col">{t('release:rt.ci')}</th>
        {#if PLANS_ENABLED}<th scope="col">{t('release:rt.plan')}</th>{/if}
      </tr>
    </thead>
    {#each groups as group (group.version)}
      <tbody>
        <tr class="group">
          <th scope="colgroup" colspan={columns}>
            <span class="gv">{t('release:rt.groupVersion', { version: group.version })}</span>
            <span class="muted">
              {showPlatform
                ? t('release:rt.groupCountPlatforms', { count: group.rows.length, platforms: formatList(group.platforms.map(platformLabel)) })
                : t('release:rt.groupCount', { count: group.rows.length })}
              {#if !group.inProgress}{t('release:rt.allLive')}{/if}
            </span>
          </th>
        </tr>
        {#each group.rows as row (row.key)}
          {@const isOpen = open.has(row.key)}
          {@const app = apps[row.appId]}
          {@const promote = canPrepare ? promoteOption(row.release, group.rows.map((r) => r.release)) : null}
          <tr class="item" class:open={isOpen}>
            <td class="expander">
              <button
                type="button"
                class="bare toggle"
                aria-expanded={isOpen}
                aria-controls="{uid}-{row.key}"
                aria-label={isOpen ? t('release:rt.hideDetails', { what: rowName(row) }) : t('release:rt.showDetails', { what: rowName(row) })}
                onclick={() => toggle(row.key)}
              >
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={16} />
              </button>
            </td>
            <th scope="row" class="version"><a href={appAddress(row.appId, 'releases', scope, row.version)}>{row.version}</a></th>
            <td>
              <span class="plat">
                <PlatformBadge platform={row.platform} />
                {#if row.track !== null}<span class="muted track">{row.trackText}</span>{/if}
                {#if promote}<a class="promote" href={promoteHref(promote)} title={t('release:rt.promoteTitle', { to: promote.to })}>{promote.label}</a>{/if}
              </span>
            </td>
            <td class="tabular">{row.buildText}</td>
            <td>
              <ReleaseStatus status={row.status} rawState={row.release.rawState} sentForReviewAt={row.release.sentForReviewAt} />
            </td>
            <td class="num tabular">
              {#if row.rolloutText}{row.rolloutText}{:else}<span class="muted" title={supports(row.platform, 'phasedRelease') ? t('release:rt.noPhasedShare') : t('release:rt.noShare')}>—</span>{/if}
            </td>
            <td class="muted">
              {#if row.at !== null}
                <time
                  datetime={new Date(row.at).toISOString()}
                  title={dateTitle(row.at, row.atSource, row.platform)}
                >{formatDate(row.at, { year: 'numeric', month: 'short', day: 'numeric' })}{#if row.atSource === 'seen'}<span class="seen"> {t('release:rt.seen')}</span>{/if}</time>
              {:else}
                <span aria-label={t('release:rt.notReported')}>—</span>
              {/if}
            </td>
            <td>
              {#if row.ci.state === 'unknown'}
                <span class="muted" title={row.ci.title}>—</span>
              {:else}
                <span title={row.ci.title}><Badge tone={row.ci.tone} dot={row.ci.dot}>{row.ci.label}</Badge></span>
              {/if}
            </td>
            {#if PLANS_ENABLED}
              <td>
                {#if row.plan.kind === 'plan'}
                  <span title={row.plan.title}><Badge tone={row.plan.tone}>{row.plan.label}</Badge></span>
                {:else}
                  <span class="muted" title={row.plan.title}>{row.plan.label}</span>
                {/if}
              </td>
            {/if}
          </tr>
          {#if isOpen && app}
            <tr class="detail-row" id="{uid}-{row.key}">
              <td colspan={columns}>
                <ReleaseRowDetail {api} {workspaceId} {role} {row} {app} builds={builds[row.appId] ?? null} {now} {scope} {promote} />
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    {/each}
  </table>
</div>

<style>
  .seen {
    font-size: var(--text-xs, 0.75rem);
  }
  /* Readable type (docs/design/readability.md): 16px rows, 13px column heads, a little more air per row. */
  .releases {
    width: 100%;
    font-size: var(--text-md);
    border-collapse: collapse;
  }

  .releases th,
  .releases td {
    padding: var(--space-2) var(--space-3);
    vertical-align: middle;
  }

  .releases thead th {
    font-size: var(--text-sm);
  }

  .group th {
    padding-top: var(--space-3);
    font-size: var(--text-md);
    color: var(--ink);
    text-align: left;
    background: var(--surface-sunken);
    border-top: 1px solid var(--line);
  }

  .gv {
    margin-right: var(--space-2);
    font-weight: var(--weight-semibold);
  }

  .expander {
    width: 2rem;
    padding-right: 0;
  }

  .toggle {
    display: inline-grid;
    place-items: center;
    width: 24px;
    height: 24px;
    color: var(--muted);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .toggle:hover {
    color: var(--ink);
    background: var(--surface-hover);
  }

  .toggle:focus-visible {
    outline: var(--ring);
    outline-offset: 1px;
  }

  .version {
    font-weight: var(--weight-semibold);
    text-align: left;
  }

  .plat {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    white-space: nowrap;
  }

  .track {
    font-size: var(--text-sm);
  }

  .promote {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
  }

  tr.open > td,
  tr.open > th {
    background: var(--accent-bg);
  }

  .detail-row > td {
    padding: 0;
    border-top: 1px solid var(--line);
  }
</style>
