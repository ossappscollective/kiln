<!--
  AlertInbox: the person's alerts in groups (needs attention, for your information, resolved), newest first. Each alert shows what
  happened, how often it repeated, and when; it can be marked read or snoozed (an app and type mute). Reads and snoozes go to the
  server and the bell's count follows. Props: api, workspaceId, apps (id and name), onchange? (after a mute was made).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { alertStore } from '../../lib/alert-store.svelte.ts';
  import { type InboxAlert, groupInbox, severityLabels, severityTone, snoozeChoices } from '../../lib/alerts.ts';
  import { fullTime, timeAgo } from '../../lib/format.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import Section from '../ui/Section.svelte';

  let {
    api,
    workspaceId,
    apps,
    onchange,
  }: { api: Api; workspaceId: string; apps: { id: string; name: string }[]; onchange?: () => void } = $props();

  const PAGE = 50;
  let alerts = $state<InboxAlert[] | null>(null);
  let hasMore = $state(false);
  let unreadOnly = $state(false);
  let error = $state('');
  let notice = $state('');
  let busy = $state('');

  const groups = $derived(groupInbox(alerts ?? []));
  const unread = $derived((alerts ?? []).filter((a) => !a.read).length);
  const appName = (id: string | null) => (id === null ? '' : (apps.find((a) => a.id === id)?.name ?? 'An app'));

  async function load(more: boolean) {
    error = '';
    try {
      const last = more && alerts && alerts.length > 0 ? alerts[alerts.length - 1] : undefined;
      const page = await api.alertInbox(workspaceId, {
        limit: PAGE,
        unread: unreadOnly,
        ...(last ? { before: last.lastAt } : {}),
      });
      alerts = more && alerts ? alerts.concat(page.alerts.filter((a) => !alerts?.some((x) => x.id === a.id))) : page.alerts;
      hasMore = page.hasMore;
      alertStore.setUnread(page.unreadCount);
    } catch (e) {
      if (!more) alerts = null;
      error = e instanceof ApiError ? e.message : 'Could not load your alerts.';
    }
  }

  $effect(() => {
    void workspaceId;
    void unreadOnly;
    alerts = null;
    notice = '';
    void load(false);
  });

  async function markRead(ids: string[] | 'all') {
    busy = ids === 'all' ? 'all' : (ids[0] ?? '');
    error = '';
    try {
      const result = await api.markAlertsRead(workspaceId, ids === 'all' ? { all: true } : { ids });
      alertStore.setUnread(result.unreadCount);
      if (alerts) {
        const set = ids === 'all' ? null : ids;
        alerts = alerts.map((a) => (set === null || set.indexOf(a.id) >= 0 ? { ...a, read: true } : a));
      }
      if (unreadOnly) await load(false);
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not mark the alerts as read.';
    } finally {
      busy = '';
    }
  }

  async function snooze(a: InboxAlert, value: string) {
    if (value === '') return;
    const choice = snoozeChoices[Number(value)];
    if (!choice) return;
    busy = a.id;
    error = '';
    try {
      await api.createAlertMute(workspaceId, {
        appId: a.appId,
        alertType: a.type,
        ...(choice.hours === null ? {} : { hours: choice.hours }),
      });
      notice = `Snoozed this kind of alert${a.appId ? ` for ${appName(a.appId)}` : ''}: ${choice.label.toLowerCase()}.`;
      onchange?.();
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'Could not snooze the alert.';
    } finally {
      busy = '';
    }
  }
</script>

<div class="stack">
  <div class="row between wrap">
    <label class="check">
      <input type="checkbox" bind:checked={unreadOnly} />
      Unread only
    </label>
    <Button icon="check" disabled={unread === 0 && alertStore.unread === 0} loading={busy === 'all'} onclick={() => markRead('all')}>
      Mark all read
    </Button>
  </div>

  {#if error}<Alert tone="error">{error}</Alert>{/if}
  {#if notice}<Alert tone="ok">{notice}</Alert>{/if}

  {#if alerts === null && !error}
    <p class="muted" role="status">Loading alerts.</p>
  {:else if alerts !== null && groups.length === 0}
    <EmptyState
      icon="bell"
      title={unreadOnly ? 'Nothing unread' : 'No alerts yet'}
      description={unreadOnly ? 'Every alert has been read.' : 'When something needs your attention it appears here, and in your email or as a desktop notification if you asked for that.'}
    />
  {:else}
    {#each groups as group (group.id)}
      <Section title={group.title} key={`alerts-${group.id}`} count={group.alerts.length} defaultOpen={group.id !== 'resolved'}>
        <ul class="list">
          {#each group.alerts as a (a.id)}
            <li class:unread={!a.read}>
              <div class="main">
                <p class="title">
                  <Badge tone={severityTone[a.severity]}>{severityLabels[a.severity]}</Badge>
                  {#if !a.read}<span class="visually-hidden">Unread. </span>{/if}<span class="name">{a.title}</span>
                  {#if a.count > 1}<Badge tone="neutral">{a.count} times</Badge>{/if}
                </p>
                {#if a.body}<p class="body">{a.body}</p>{/if}
                <p class="meta muted">
                  {#if a.appId}{appName(a.appId)} · {/if}
                  <time datetime={new Date(a.lastAt).toISOString()} title={fullTime(a.lastAt)}>{timeAgo(a.lastAt)}</time>
                  {#if a.count > 1} · first {timeAgo(a.firstAt)}{/if}
                  {#if a.resolvedAt !== null} · resolved {timeAgo(a.resolvedAt)}{/if}
                </p>
              </div>
              <div class="side">
                {#if !a.read}
                  <Button size="sm" variant="ghost" loading={busy === a.id} onclick={() => markRead([a.id])}>Mark read</Button>
                {/if}
                <select
                  aria-label="Snooze this kind of alert: {a.title}"
                  disabled={busy === a.id}
                  value=""
                  onchange={(e) => {
                    void snooze(a, e.currentTarget.value);
                    e.currentTarget.value = '';
                  }}
                >
                  <option value="">Snooze…</option>
                  {#each snoozeChoices as c, i (c.label)}<option value={String(i)}>{c.label}</option>{/each}
                </select>
              </div>
            </li>
          {/each}
        </ul>
      </Section>
    {/each}
    {#if hasMore}
      <div><Button onclick={() => load(true)}>Show older alerts</Button></div>
    {/if}
  {/if}
</div>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  li {
    display: flex;
    gap: var(--space-4);
    justify-content: space-between;
    padding: var(--space-3) 0;
    border-top: 1px solid var(--line);
  }
  li:first-child {
    border-top: 0;
  }
  .main {
    min-width: 0;
  }
  .title,
  .body,
  .meta {
    margin: 0;
  }
  .title {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  li.unread .name {
    font-weight: var(--weight-semibold);
  }
  .body {
    margin-top: var(--space-1);
    overflow-wrap: anywhere;
  }
  .meta {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    align-items: flex-end;
    flex-shrink: 0;
  }
  .side select {
    width: auto;
  }
  @media (max-width: 600px) {
    li {
      flex-direction: column;
    }
    .side {
      flex-direction: row;
      align-items: center;
    }
  }
</style>
