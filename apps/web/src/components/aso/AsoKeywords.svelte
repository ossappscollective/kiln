<!--
  AsoKeywords: the tracked keywords of the app records in scope, as one table: keyword, market, current
  rank, change since the last check, best rank, a sparkline of the history and when it was last checked.
  Members add (paste many), remove and mark a keyword high priority, and press "Check now" (it reads the public
  store: Apple's Search API, and Google Play only when the operator switched that on). A limit the store or
  this server states ("try again in 30 seconds") disables the button until then. Viewers read only.
  A rank is a position in the results the store's search returned (for Apple a proxy for the App Store's own search);
  "50+" is "not within the first 50", never "does not rank".
  A `?add=1` in the address (the next steps link to it) opens the add panel once.
  Props: api, workspaceId, role, members, config, keywords (all of them), canWrite, onchanged, now.
  "Suggest keywords" (AI, only when AI is on) asks for ideas in the language each app tracks most; they arrive in the AI suggestions tray above.
-->
<script lang="ts">
  import type { Role } from '@mrm/core';
  import { untrack } from 'svelte';
  import { address, replaceHash } from '../../lib/address.svelte.ts';
  import type { Api } from '../../lib/api.ts';
  import { asksToAddKeywords, withoutParam } from '../../lib/aso-budget.ts';
  import {
    type AsoCheck,
    type AsoConfig,
    type AsoKeyword,
    type KeywordSort,
    asoErrorMessage,
    bestRank,
    changeInfo,
    checkErrorText,
    filterKeywords,
    keywordSorts,
    localesOf,
    marketText,
    rankText,
    refreshText,
    refreshWaitSeconds,
    resultWaitSeconds,
    sortKeywords,
    waitText,
  } from '../../lib/aso.ts';
  import { timeAgo } from '../../lib/format.ts';
  import { platformLabel, runLimited } from '../../lib/portfolio.ts';
  import { toast } from '../../lib/toast.svelte.ts';
  import type { AppSummary } from '../../lib/types.ts';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';
  import InfoTip from '../ui/InfoTip.svelte';
  import StatChip from '../ui/StatChip.svelte';
  import AddKeywords from './AddKeywords.svelte';
  import AsoBar from './AsoBar.svelte';
  import Sparkline from './Sparkline.svelte';
  import SuggestKeywords from '../ai/SuggestKeywords.svelte';

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
  const playOff = $derived(config !== null && !config.play.enabled);

  let query = $state('');
  let sort = $state<KeywordSort>('rank');
  let adding = $state(false);
  let removing = $state<string | null>(null);
  let busyId = $state<string | null>(null);

  // A link from the next steps (`?add=1`) opens the add panel once and leaves the address clean.
  $effect(() => {
    if (!asksToAddKeywords(address.hash)) return;
    untrack(() => {
      if (canWrite) adding = true;
      replaceHash(withoutParam(location.hash, 'add'));
    });
  });

  const rows = $derived(sortKeywords(filterKeywords(keywords, query), sort));
  const top10 = $derived(keywords.filter((k) => k.state === 'ranked' && k.rank !== null && k.rank <= 10).length);
  const unchecked = $derived(keywords.filter((k) => k.state === null).length);

  // ----- History for the sparklines: our own database, a few at a time, once per check.
  type History = { stamp: number | null; checks: AsoCheck[] };
  let histories = $state<Record<string, History | undefined>>({});
  let historyRun = 0;

  $effect(() => {
    const list = keywords;
    const space = workspaceId;
    const mine = ++historyRun;
    const wanted = list.filter((k) => k.lastCheckedAt !== null && histories[k.id]?.stamp !== k.lastCheckedAt);
    if (wanted.length === 0) return;
    void runLimited(wanted, 4, async (k) => {
      try {
        const h = await api.asoKeywordHistory(space, k.appId, k.id, 30);
        if (mine === historyRun) histories[k.id] = { stamp: k.lastCheckedAt, checks: h.checks };
      } catch {
        if (mine === historyRun) histories[k.id] = { stamp: k.lastCheckedAt, checks: [] };
      }
    });
  });

  const best = (k: AsoKeyword): number | null => {
    const h = histories[k.id];
    const fromHistory = h ? bestRank(h.checks) : null;
    const current = k.state === 'ranked' ? k.rank : null;
    return fromHistory !== null && current !== null ? Math.min(fromHistory, current) : (fromHistory ?? current);
  };

  // ----- Check now
  let checking = $state(false);
  let waitUntil = $state(0);
  let tick = $state(Date.now());
  const waiting = $derived(waitUntil > tick);
  const waitLeft = $derived(Math.max(0, Math.ceil((waitUntil - tick) / 1000)));

  $effect(() => {
    if (waitUntil <= Date.now()) return;
    tick = Date.now();
    const timer = setInterval(() => {
      tick = Date.now();
      if (tick >= waitUntil) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  });

  /** Google Play is left out while its reading is off: the server would answer 409 and nothing is requested. */
  const targets = $derived(members.filter((m) => m.platform !== 'android' || !playOff));
  const nothingToCheck = $derived(keywords.length === 0 || targets.length === 0);

  async function check() {
    if (checking || waiting) return;
    checking = true;
    const done: string[] = [];
    const problems: string[] = [];
    let wait = 0;
    try {
      for (const app of targets) {
        if (!keywords.some((k) => k.appId === app.id)) continue;
        try {
          const out = await api.refreshAso(workspaceId, app.id);
          done.push(refreshText(out.result));
          wait = Math.max(wait, resultWaitSeconds(out.result) ?? 0);
        } catch (e) {
          problems.push(`${multi ? `${platformLabel(app.platform)}: ` : ''}${asoErrorMessage(e, 'The check failed.')}`);
          wait = Math.max(wait, refreshWaitSeconds(e) ?? 0);
        }
      }
    } finally {
      checking = false;
    }
    if (wait > 0) waitUntil = Date.now() + wait * 1000;
    if (done.length > 0) toast.success(done.join(' '));
    if (problems.length > 0) toast.error(problems.join(' '));
    await onchanged();
  }

  async function remove(k: AsoKeyword) {
    busyId = k.id;
    try {
      await api.deleteAsoKeyword(workspaceId, k.appId, k.id);
      toast.success(`Stopped tracking “${k.term}”.`);
      removing = null;
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not remove the keyword.'));
    } finally {
      busyId = null;
    }
  }

  async function togglePriority(k: AsoKeyword) {
    busyId = k.id;
    try {
      await api.updateAsoKeyword(workspaceId, k.appId, k.id, { priority: k.priority >= 3 ? 2 : 3 });
      await onchanged();
    } catch (e) {
      toast.error(asoErrorMessage(e, 'Could not change the priority.'));
    } finally {
      busyId = null;
    }
  }

  async function added() {
    adding = false;
    await onchanged();
  }
</script>

<div class="keywords">
  <AsoBar label="Keyword actions">
    {#if keywords.length > 0}
      <input class="search" type="search" placeholder="Filter keywords" aria-label="Filter keywords" bind:value={query} />
      <select aria-label="Sort keywords" bind:value={sort}>
        {#each keywordSorts as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
      </select>
      <span class="chips">
        <StatChip label="tracked" value={keywords.length} />
        <StatChip label="in top 10" value={top10} tone="ok" />
        {#if unchecked > 0}<StatChip label="not checked yet" value={unchecked} tone="info" />{/if}
      </span>
    {/if}
    <span class="spacer"></span>
    {#if canWrite}
      {#if keywords.length > 0}
        <SuggestKeywords
          {api}
          {workspaceId}
          {role}
          {members}
          {keywords}
          localeFor={(app) => localesOf(keywords.filter((k) => k.appId === app.id))[0] ?? null}
        />
      {/if}
      <Button
        icon="refresh"
        loading={checking}
        disabled={nothingToCheck || waiting}
        title={waiting ? `The limit was reached. Try again in ${waitText(waitLeft)}.` : targets.length === 0 && keywords.length > 0 ? 'Google Play reading is switched off.' : 'Read the public store for every keyword and competitor'}
        onclick={check}
      >
        {checking ? 'Checking…' : waiting ? `Check now (${waitLeft}s)` : 'Check now'}
      </Button>
      <Button variant="primary" icon="plus" onclick={() => (adding = !adding)} aria-expanded={adding}>Add keywords</Button>
    {/if}
  </AsoBar>

  {#if adding && canWrite}
    <AddKeywords {api} {workspaceId} {members} {config} ondone={added} oncancel={() => (adding = false)} />
  {/if}

  {#if keywords.length === 0}
    <p class="empty">
      No keywords tracked yet.
      {#if canWrite}
        <Button size="sm" variant="link" onclick={() => (adding = true)}>Add keywords</Button>
      {:else}
        <span class="muted">A member can add them.</span>
      {/if}
    </p>
  {:else if rows.length === 0}
    <p class="empty muted">No keyword matches “{query}”.</p>
  {:else}
    <div class="table-wrap">
      <table class="compact">
        <thead>
          <tr>
            <th scope="col">Keyword</th>
            <th scope="col">Market</th>
            <th scope="col" class="num">
              Rank
              <InfoTip label="What a rank is" align="start">
                <p class="tip">
                  The position of the app in the results the store's search returned for the term. For the App Store it is the position in Apple's public Search API
                  results, a proxy for the App Store's own search. “{config?.limits.rankDepth ?? 50}+” means not within the first {config?.limits.rankDepth ?? 50} results, not that
                  it does not rank at all.
                </p>
              </InfoTip>
            </th>
            <th scope="col" class="num">Change</th>
            <th scope="col" class="num">Best</th>
            <th scope="col">Trend</th>
            <th scope="col">Checked</th>
            {#if canWrite}<th scope="col"><span class="visually-hidden">Actions</span></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each rows as k (k.id)}
            {@const rank = rankText(k)}
            {@const move = changeInfo(k.change, k.state !== null)}
            {@const hist = histories[k.id]}
            <tr>
              <th scope="row" class="term">
                <span class="termline">
                  {#if canWrite}
                    <button
                      type="button"
                      class="bare star"
                      aria-pressed={k.priority >= 3}
                      aria-label="High priority: {k.term}"
                      title={k.priority >= 3 ? 'High priority' : 'Mark as high priority'}
                      disabled={busyId === k.id}
                      onclick={() => togglePriority(k)}
                    >
                      <Icon name={k.priority >= 3 ? 'star-filled' : 'star'} size={14} />
                    </button>
                  {:else if k.priority >= 3}
                    <span class="star on" title="High priority"><Icon name="star-filled" size={14} /><span class="visually-hidden">High priority</span></span>
                  {/if}
                  <span class="truncate" title={k.term}>{k.term}</span>
                  {#if multi}<Badge>{platformLabel(k.platform)}</Badge>{/if}
                  {#if k.tag}<Badge tone="info">{k.tag}</Badge>{/if}
                </span>
              </th>
              <td class="muted">{marketText(k)}</td>
              <td class="num">
                <span class:muted={rank.muted} title={rank.title}>{rank.text}</span>
                {#if k.error}
                  <InfoTip label="The last check failed" icon="alert-triangle" text={checkErrorText(k.error)} />
                {:else if k.platform === 'android' && playOff && k.state === null}
                  <InfoTip label="Google Play reading is off" icon="info" text="Google Play reads are switched off on this server, so this keyword is kept but not checked. The operator can switch them on; see the pill above." />
                {/if}
              </td>
              <td class="num">
                <span class="move {move.tone}" title={move.title}>
                  {#if move.icon}<Icon name={move.icon} size={12} />{/if}{move.text}
                </span>
              </td>
              <td class="num">{best(k) ?? '–'}</td>
              <td>
                {#if k.lastCheckedAt === null}
                  <span class="muted">–</span>
                {:else if hist}
                  <Sparkline
                    checks={hist.checks}
                    label="{hist.checks.length} {hist.checks.length === 1 ? 'check' : 'checks'}{bestRank(hist.checks) !== null ? `, best ${bestRank(hist.checks)}` : ''}, latest {rank.text}"
                  />
                {:else}
                  <span class="muted" aria-hidden="true">…</span>
                {/if}
              </td>
              <td class="muted" title={k.lastCheckedAt ? new Date(k.lastCheckedAt).toLocaleString() : undefined}>
                {k.lastCheckedAt ? timeAgo(k.lastCheckedAt, now) : 'Never'}
              </td>
              {#if canWrite}
                <td class="actions">
                  {#if removing === k.id}
                    <span class="confirm">
                      Remove “{k.term}” and its history?
                      <Button size="sm" variant="danger" loading={busyId === k.id} onclick={() => remove(k)}>Remove</Button>
                      <Button size="sm" variant="ghost" onclick={() => (removing = null)}>Cancel</Button>
                    </span>
                  {:else}
                    <Button size="sm" variant="ghost" iconOnly icon="trash" label="Remove {k.term}" onclick={() => (removing = k.id)} />
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

<style>
  .search {
    width: 14rem;
  }

  .chips {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .empty {
    margin: var(--space-4) 0;
    color: var(--ink);
  }

  .term {
    min-width: 12rem;
    max-width: 22rem;
    font-weight: var(--weight-medium);
    text-align: left;
  }

  .termline {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    min-width: 0;
  }

  .star {
    display: inline-flex;
    flex: none;
    padding: 2px;
    color: var(--faint);
    cursor: pointer;
    border-radius: var(--radius-sm);
  }

  .star:hover:not(:disabled) {
    color: var(--ink);
  }

  .star[aria-pressed='true'],
  .star.on {
    color: var(--warn);
  }

  .star:focus-visible {
    outline: 2px solid var(--accent);
  }

  .move {
    display: inline-flex;
    gap: 2px;
    align-items: center;
    font-weight: var(--weight-medium);
  }

  .move.ok {
    color: var(--ok-ink);
  }

  .move.bad {
    color: var(--bad-ink);
  }

  .move.neutral {
    color: var(--muted);
  }

  .confirm {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
    justify-content: flex-end;
    font-size: var(--text-sm);
  }

  .tip {
    margin: 0;
  }
</style>
