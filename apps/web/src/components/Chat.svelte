<!--
  Chat: Slack and Microsoft Teams destinations (docs/chat-integrations.md). Alerts, release events and a daily summary land in the
  channels a destination points at. Owners and admins manage them; the webhook address is a secret that is typed once and never
  shown again (a destination shows only the end of it). Each destination has: a test message, its routing rules, its delivery log.
-->
<script lang="ts">
  import { type Role, can } from '@kiln/core';
  import { tick } from 'svelte';
  import { type Api, ApiError } from '../lib/api.ts';
  import type { CatalogEntry } from '../lib/alerts/alerts.ts';
  import {
    type ChatDestination,
    describeRoute,
    hintText,
    hourLabel,
    providerName,
    statusView,
    testResult,
  } from '../lib/chat/chat.ts';
  import { timeAgo } from '../lib/format.ts';
  import { availableLocales } from '../lib/i18n/locales.ts';
  import { t } from '../lib/i18n/t.ts';
  import { toneIcon } from '../lib/status-icons.ts';
  import type { AppSummary } from '../lib/types.ts';
  import DeliveryLog from './chat/DeliveryLog.svelte';
  import DestinationForm from './chat/DestinationForm.svelte';
  import RoutesEditor from './chat/RoutesEditor.svelte';
  import Alert from './ui/Alert.svelte';
  import Badge from './ui/Badge.svelte';
  import Button from './ui/Button.svelte';
  import EmptyState from './ui/EmptyState.svelte';
  import Modal from './ui/Modal.svelte';
  import PageHeader from './ui/PageHeader.svelte';
  import { useNow } from '../lib/app-state/clock.svelte.ts';

  /** `embedded`: drawn inside the Settings page, which already has the page title; the description and the new button stay. */
  let { api, workspaceId, role, embedded = false }: { api: Api; workspaceId: string; role: Role; embedded?: boolean } = $props();

  const canRead = $derived(can(role, 'chat.read'));
  const canManage = $derived(can(role, 'chat.manage'));

  type Panel = { id: string; kind: 'edit' | 'routes' | 'log' };

  let destinations = $state<ChatDestination[] | null>(null);
  let catalog = $state<CatalogEntry[]>([]);
  let apps = $state<AppSummary[]>([]);
  let error = $state('');
  let notice = $state('');
  let noticeEl = $state<HTMLElement>();
  let adding = $state(false);
  let panel = $state<Panel | null>(null);
  let busyId = $state('');
  let deleting = $state<ChatDestination | null>(null);
  let deleteOpen = $state(false);
  /** The line under a destination's buttons after "Send test message". */
  let testLines = $state<Record<string, { tone: 'ok' | 'bad' | 'info' | 'warn' | 'neutral'; text: string }>>({});

  const clock = useNow();
  const now = $derived(clock.value);
  const languageName = (code: string) => availableLocales.find((l) => l.code === code)?.name ?? code;

  async function load() {
    error = '';
    try {
      destinations = (await api.chatDestinations(workspaceId)).destinations;
    } catch (e) {
      destinations = null;
      error = e instanceof ApiError ? e.message : t('chat:page.loadFailed');
    }
  }

  // The catalog and the apps feed the routing editor; they are not needed to list destinations.
  async function loadChoices() {
    try {
      const [c, a] = await Promise.all([api.alertCatalog(workspaceId), api.apps(workspaceId)]);
      catalog = c.catalog;
      apps = a.apps;
    } catch {
      // The editor then offers no types; the list still works.
    }
  }

  $effect(() => {
    void workspaceId;
    destinations = null;
    adding = false;
    panel = null;
    notice = '';
    testLines = {};
    if (canRead) {
      void load();
      void loadChoices();
    }
  });

  async function announce(message: string) {
    notice = message;
    await tick();
    noticeEl?.focus();
  }

  async function onsaved(destination: ChatDestination, created: boolean) {
    adding = false;
    panel = null;
    await load();
    await announce(t('chat:page.saved', { name: destination.name }));
    // A new destination starts with the default rules: show them so the next step is obvious.
    if (created) panel = { id: destination.id, kind: 'routes' };
  }

  async function onroutes(destination: ChatDestination) {
    panel = null;
    await load();
    await announce(t('chat:page.routesSaved', { name: destination.name }));
  }

  async function test(d: ChatDestination) {
    busyId = d.id;
    error = '';
    testLines = { ...testLines, [d.id]: { tone: 'info', text: t('chat:test.waiting') } };
    try {
      const { deliveryId } = await api.testChatDestination(workspaceId, d.id);
      // Follow it for a few seconds: the job runs in the background and may retry.
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? 600 : 1500));
        const { deliveries } = await api.chatDeliveries(workspaceId, d.id, 5);
        const mine = deliveries.find((x) => x.id === deliveryId);
        const result = testResult(mine);
        if (result) testLines = { ...testLines, [d.id]: result };
        if (mine && mine.status !== 'queued' && mine.status !== 'retrying') break;
      }
      const last = testLines[d.id];
      if (last?.tone === 'info') testLines = { ...testLines, [d.id]: { tone: 'info', text: t('chat:test.noResult') } };
      await load();
    } catch (e) {
      const { [d.id]: _gone, ...rest } = testLines;
      testLines = rest;
      error = e instanceof ApiError ? e.message : t('chat:page.testFailed');
    } finally {
      busyId = '';
    }
  }

  function askDelete(d: ChatDestination) {
    deleting = d;
    deleteOpen = true;
  }

  async function confirmDelete() {
    const d = deleting;
    deleteOpen = false;
    if (!d) return;
    busyId = d.id;
    error = '';
    try {
      await api.deleteChatDestination(workspaceId, d.id);
      if (panel?.id === d.id) panel = null;
      await load();
      await announce(t('chat:page.deleted', { name: d.name }));
    } catch (e) {
      error = e instanceof ApiError ? e.message : t('chat:page.deleteFailed');
    } finally {
      busyId = '';
    }
  }

  const open = (d: ChatDestination, kind: Panel['kind']) => {
    panel = panel?.id === d.id && panel.kind === kind ? null : { id: d.id, kind };
    adding = false;
  };
</script>

<section>
  {#snippet newButton()}
    {#if canManage && !adding}
      <Button variant="primary" icon="plus" id="new-chat-destination" onclick={() => { adding = true; panel = null; notice = ''; }}>{t('chat:page.new')}</Button>
    {/if}
  {/snippet}
  {#if embedded}
    <div class="embedded-head">
      <p class="lead">{t('chat:page.description')}</p>
      {@render newButton()}
    </div>
  {:else}
    <PageHeader title={t('chat:page.title')} description={t('chat:page.description')}>
      {#snippet actions()}{@render newButton()}{/snippet}
    </PageHeader>
  {/if}

  {#if !canRead}
    <Alert tone="info">{t('chat:page.noRead')}</Alert>
  {:else}
    <p class="notice" class:shown={notice} bind:this={noticeEl} role="status" tabindex="-1">{notice}</p>
    {#if error}<div class="block"><Alert tone="error">{error}</Alert></div>{/if}

    {#if adding}
      <div class="block">
        <DestinationForm
          {api}
          {workspaceId}
          {onsaved}
          oncancel={async () => {
            adding = false;
            await tick();
            document.getElementById('new-chat-destination')?.focus();
          }}
        />
      </div>
    {/if}

    {#if destinations === null && !error}
      <p class="muted">{t('chat:page.loading')}</p>
    {:else if destinations && destinations.length === 0 && !adding}
      <EmptyState icon="message" title={t('chat:page.emptyTitle')} description={t('chat:page.emptyText')} />
    {:else if destinations}
      <ul class="list">
        {#each destinations as d (d.id)}
          {@const last = d.lastDelivery}
          {@const line = testLines[d.id]}
          <li class="card destination" class:inactive={!d.enabled}>
            <div class="row top">
              <div class="who">
                <strong>{d.name}</strong>
                <span class="muted text-sm">{providerName(d.provider)} · {t('chat:card.endsIn', { hint: hintText(d) })}</span>
              </div>
              <span class="spacer"></span>
              <Badge tone={d.enabled ? 'ok' : 'neutral'} icon={toneIcon(d.enabled ? 'ok' : 'neutral')}>{d.enabled ? t('chat:card.on') : t('chat:card.off')}</Badge>
            </div>
            <div class="facts muted text-sm">
              <span>{t('chat:card.language', { language: languageName(d.locale) })}</span>
              <span>{d.digest === 'daily' ? t('chat:card.digestDaily', { hour: hourLabel(d.digestHour), zone: d.timezone }) : t('chat:card.digestOff')}</span>
              <span>{last ? t('chat:card.lastDelivery', { status: statusView(last.status).label, when: timeAgo(last.at, now) }) : t('chat:card.noDelivery')}</span>
              {#if d.allowAnyHost}<span>{t('chat:card.anyHost')}</span>{/if}
            </div>

            {#if d.routes.length > 0}
              <details class="rules">
                <summary>{t('chat:card.rules', { count: d.routes.length })}</summary>
                <div class="table-wrap">
                  <table>
                    <caption class="visually-hidden">{t('chat:routes.caption')}</caption>
                    <thead>
                      <tr>
                        <th scope="col">{t('chat:routes.col.types')}</th>
                        <th scope="col">{t('chat:routes.col.severity')}</th>
                        <th scope="col">{t('chat:routes.col.apps')}</th>
                        <th scope="col">{t('chat:routes.col.platforms')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each d.routes as route (route.id)}
                        {@const cells = describeRoute(route, apps)}
                        <tr class:inactive={!route.enabled}>
                          <td>{cells.types}{#if !route.enabled} <span class="muted">({t('chat:card.rulesOff')})</span>{/if}</td>
                          <td>{cells.severity}</td>
                          <td>{cells.apps}</td>
                          <td>{cells.platforms}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              </details>
            {/if}

            <div class="row buttons">
              {#if canManage}
                <Button size="sm" loading={busyId === d.id} disabled={busyId === d.id} label={t('chat:action.testLabel', { name: d.name })} onclick={() => test(d)}>{busyId === d.id ? t('chat:action.testing') : t('chat:action.test')}</Button>
                <Button size="sm" disabled={busyId === d.id} label={t('chat:action.editLabel', { name: d.name })} onclick={() => open(d, 'edit')}>{t('chat:action.edit')}</Button>
                <Button size="sm" disabled={busyId === d.id} label={t('chat:action.routingLabel', { name: d.name })} onclick={() => open(d, 'routes')}>{t('chat:action.routing')}</Button>
              {/if}
              <Button size="sm" disabled={busyId === d.id} label={t('chat:action.logLabel', { name: d.name })} onclick={() => open(d, 'log')}>{t('chat:action.log')}</Button>
              {#if canManage}
                <Button size="sm" variant="danger" disabled={busyId === d.id} label={t('chat:action.deleteLabel', { name: d.name })} onclick={() => askDelete(d)}>{t('chat:action.delete')}</Button>
              {/if}
            </div>
            {#if line}
              <p class="result" role="status"><Badge tone={line.tone} icon={toneIcon(line.tone)}>{line.text}</Badge></p>
            {/if}

            {#if panel?.id === d.id}
              <div class="panel">
                {#if panel.kind === 'edit'}
                  <DestinationForm {api} {workspaceId} destination={d} {onsaved} oncancel={() => (panel = null)} />
                {:else if panel.kind === 'routes'}
                  <RoutesEditor {api} {workspaceId} destination={d} {catalog} {apps} onsaved={onroutes} oncancel={() => (panel = null)} />
                {:else}
                  <DeliveryLog {api} {workspaceId} destination={d} onclose={() => (panel = null)} />
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <p class="hint footer">{t('chat:page.footer')}</p>
  {/if}
</section>

<Modal bind:open={deleteOpen} size="sm" title={t('chat:delete.title')} onclose={() => (deleting = null)}>
  <p>{t('chat:delete.body', { name: deleting?.name ?? '' })}</p>
  {#snippet footer()}
    <Button onclick={() => (deleteOpen = false)}>{t('common:action.cancel')}</Button>
    <Button variant="danger-solid" onclick={confirmDelete}>{t('chat:action.delete')}</Button>
  {/snippet}
</Modal>

<style>
  .block {
    margin-bottom: 20px;
  }

  .list {
    display: grid;
    gap: 14px;
    padding: 0;
    margin: 0;
    list-style: none;
  }

  .destination {
    display: grid;
    gap: 10px;
  }

  .inactive {
    opacity: 0.85;
  }

  .top {
    gap: 12px;
  }

  .who {
    display: grid;
    gap: 2px;
  }

  .facts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 16px;
  }

  .buttons {
    flex-wrap: wrap;
    gap: 6px;
  }

  .result {
    margin: 0;
  }

  .panel {
    margin-top: 6px;
  }

  .rules summary {
    cursor: pointer;
  }

  .footer {
    margin-top: 16px;
  }

  .notice {
    display: none;
    padding: 10px 12px;
    margin: 0 0 16px;
    color: var(--ok-ink);
    background: var(--ok-bg);
    border-radius: var(--radius-sm);
  }

  .notice.shown {
    display: block;
  }

  .embedded-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--space-4);
  }

  .embedded-head .lead {
    flex: 1 1 18rem;
    margin: 0;
    color: var(--muted);
  }
</style>
