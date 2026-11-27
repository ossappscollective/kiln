<!--
  AlertSettings: what one person receives. Three parts: how and when (lowest severity, quiet hours with a time zone, the digest),
  the matrix of alert types by channel (for all apps or one app; "workspace default" until the person chooses), and the mutes and
  snoozes. Test buttons send one alert through one channel and show the result in words. Props: api, workspaceId, catalog, page
  (the person's settings, choices and mutes), apps, onreload (after anything that other tabs also show).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { alertStore } from '../../lib/app-state/alerts-facade.ts';
  import { type NotifyState, inDesktopShell, notificationState, notifyStateKeys, requestNotificationPermission } from '../../lib/alerts/notify.ts';
  import {
    type AlertChannel,
    type AlertSeverity,
    type CatalogEntry,
    type Delivery,
    type Mute,
    type PersonalChannel,
    type Preference,
    type SettingsPage,
    browserTimeZone,
    channelLabel,
    describeOutcome,
    effectiveChannels,
    matrixGroups,
    minutesToTime,
    muteLabel,
    personalChannels,
    quietSummary,
    severityLabel,
    severityTone,
    snoozeChoices,
    statusLabel,
    statusTone,
    timeToMinutes,
    toggleChannel,
  } from '../../lib/alerts/alerts.ts';
  import { fullTime } from '../../lib/format.ts';
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';
  import DesktopNotifications from './DesktopNotifications.svelte';

  let {
    api,
    workspaceId,
    catalog,
    page,
    apps,
    onreload,
  }: {
    api: Api;
    workspaceId: string;
    catalog: CatalogEntry[];
    page: SettingsPage;
    apps: { id: string; name: string }[];
    onreload: () => void;
  } = $props();

  // ----- how and when ---------------------------------------------------------------------------------------------
  let minSeverity = $state<AlertSeverity>('info');
  let quietStart = $state('');
  let quietEnd = $state('');
  let timezone = $state('');
  let digest = $state<'off' | 'daily' | 'weekly'>('off');
  let digestHour = $state(8);
  let saving = $state(false);
  let saveError = $state('');
  let saved = $state('');

  $effect(() => {
    const s = page.settings;
    minSeverity = s.minSeverity;
    quietStart = minutesToTime(s.quietStart);
    quietEnd = minutesToTime(s.quietEnd);
    timezone = s.timezone ?? '';
    digest = s.digest;
    digestHour = s.digestHour;
  });

  async function saveSettings(event: SubmitEvent) {
    event.preventDefault();
    saveError = '';
    saved = '';
    const start = quietStart.trim() === '' ? null : timeToMinutes(quietStart);
    const end = quietEnd.trim() === '' ? null : timeToMinutes(quietEnd);
    if ((quietStart.trim() !== '' && start === null) || (quietEnd.trim() !== '' && end === null)) {
      saveError = t('workspace:alerts.settings.quietFormat');
      return;
    }
    if ((start === null) !== (end === null)) {
      saveError = t('workspace:alerts.settings.quietPair');
      return;
    }
    saving = true;
    try {
      const result = await api.updateAlertSettings(workspaceId, {
        minSeverity,
        quietStart: start,
        quietEnd: end,
        timezone: start === null ? (page.settings.timezone ?? null) : timezone.trim() || browserTimeZone(),
        digest,
        digestHour,
      });
      saved = t('workspace:alerts.settings.saved', { summary: quietSummary(result.settings) });
      onreload();
    } catch (e) {
      saveError = e instanceof ApiError ? e.message : t('workspace:alerts.settings.saveFailed');
    } finally {
      saving = false;
    }
  }

  // ----- tests ------------------------------------------------------------------------------------------------------
  let testing = $state<AlertChannel | ''>('');
  let testResult = $state<{ channel: PersonalChannel; deliveries: Delivery[] } | null>(null);
  let testError = $state('');
  let notify = $state<NotifyState>('default');
  const desktopShell = inDesktopShell();

  $effect(() => {
    void notificationState().then((s) => (notify = s));
  });

  /** What this window did with the test alert (the server's log only says it was queued for the app). */
  function desktopOutcomeText(outcome: typeof alertStore.notifyOutcome): string {
    switch (outcome) {
      case 'shown':
        return t('workspace:alerts.settings.desktopShown');
      case 'refused':
        return t('workspace:alerts.settings.desktopRefused');
      case 'device_off':
        return t('workspace:alerts.settings.desktopDeviceOff');
      case 'nothing_new':
        return t('workspace:alerts.settings.desktopNothingNew');
      default:
        return '';
    }
  }

  async function askDesktop() {
    notify = await requestNotificationPermission();
  }

  async function test(channel: PersonalChannel) {
    testing = channel;
    testError = '';
    testResult = null;
    try {
      if (channel === 'desktop' && notify !== 'granted') await askDesktop();
      const result = await api.sendTestAlert(workspaceId, channel);
      testResult = { channel, deliveries: result.deliveries };
      await alertStore.refresh(api, workspaceId);
    } catch (e) {
      testError = e instanceof ApiError ? e.message : t('workspace:alerts.settings.testFailed');
    } finally {
      testing = '';
    }
  }

  // ----- the matrix -------------------------------------------------------------------------------------------------
  let prefs = $state<Preference[]>([]);
  let scopeApp = $state('');
  let matrixError = $state('');
  let busyType = $state('');

  $effect(() => {
    prefs = page.preferences.slice();
  });

  const appId = $derived(scopeApp === '' ? null : scopeApp);
  const groups = $derived(
    matrixGroups(catalog)
      .map((g) => ({ ...g, entries: g.entries.filter((e) => e.rule.enabled && (appId === null || e.scope === 'app')) }))
      .filter((g) => g.entries.length > 0),
  );
  const own = (type: string): Preference | undefined =>
    prefs.filter((p) => p.alertType === type && p.appId === appId)[0];
  // With an app chosen, an app has its own choice, else the one for all apps, else the workspace default (same order as the server).
  const channelsOf = (e: CatalogEntry) => effectiveChannels(e, prefs, e.id, appId);

  async function choose(e: CatalogEntry, channel: PersonalChannel, on: boolean) {
    matrixError = '';
    busyType = e.id;
    try {
      const channels = toggleChannel(channelsOf(e), channel, on);
      const result = await api.setAlertPreference(workspaceId, e.id, { appId, channels });
      const rest = prefs.filter((p) => !(p.alertType === e.id && p.appId === appId));
      prefs = result.preference ? rest.concat([result.preference]) : rest;
    } catch (err) {
      matrixError = err instanceof ApiError ? err.message : t('workspace:alerts.settings.choiceFailed');
    } finally {
      busyType = '';
    }
  }

  async function useDefault(e: CatalogEntry) {
    matrixError = '';
    busyType = e.id;
    try {
      await api.setAlertPreference(workspaceId, e.id, { appId, channels: null });
      prefs = prefs.filter((p) => !(p.alertType === e.id && p.appId === appId));
    } catch (err) {
      matrixError = err instanceof ApiError ? err.message : t('workspace:alerts.settings.defaultFailed');
    } finally {
      busyType = '';
    }
  }

  // ----- mutes ------------------------------------------------------------------------------------------------------
  let muteApp = $state('');
  let muteType = $state('');
  let muteFor = $state('0');
  let muteBusy = $state('');
  let muteError = $state('');

  const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? t('workspace:alerts.settings.appFallback');
  const typeLabel = (id: string) => catalog.find((e) => e.id === id)?.label ?? id;
  const muteUntil = (m: Mute) => (m.until === null ? t('workspace:alerts.settings.untilOn') : t('workspace:alerts.settings.untilDate', { date: fullTime(m.until) }));

  async function addMute(event: SubmitEvent) {
    event.preventDefault();
    muteError = '';
    muteBusy = 'add';
    try {
      const choice = snoozeChoices[Number(muteFor)];
      await api.createAlertMute(workspaceId, {
        appId: muteApp === '' ? null : muteApp,
        alertType: muteType === '' ? null : muteType,
        ...(choice && choice.hours !== null ? { hours: choice.hours } : {}),
      });
      onreload();
    } catch (e) {
      muteError = e instanceof ApiError ? e.message : t('workspace:alerts.settings.muteFailed');
    } finally {
      muteBusy = '';
    }
  }

  async function removeMute(m: Mute) {
    muteError = '';
    muteBusy = m.id;
    try {
      await api.deleteAlertMute(workspaceId, m.id);
      onreload();
    } catch (e) {
      muteError = e instanceof ApiError ? e.message : t('workspace:alerts.settings.unmuteFailed');
    } finally {
      muteBusy = '';
    }
  }
</script>

<div class="stack loose">
  <DesktopNotifications {api} {workspaceId} {catalog} bind:prefs bind:notify />

  <Section title={t('workspace:alerts.settings.howTitle')} key="alerts-how" summary={quietSummary(page.settings)}>
    <form class="stack" onsubmit={saveSettings}>
      <div class="field">
        <label for="alert-min">{t('workspace:alerts.settings.minSeverity')}</label>
        <select id="alert-min" bind:value={minSeverity}>
          <option value="info">{t('workspace:alerts.settings.severityInfoUp')}</option>
          <option value="warning">{t('workspace:alerts.settings.severityWarningUp')}</option>
          <option value="critical">{t('workspace:alerts.settings.severityCriticalUp')}</option>
        </select>
        <p class="hint">{t('workspace:alerts.settings.severityHint')}</p>
      </div>

      <fieldset class="field">
        <legend>{t('workspace:alerts.settings.quietLegend')}</legend>
        <div class="row wrap">
          <div>
            <label for="alert-qs">{t('workspace:alerts.settings.quietFrom')}</label>
            <input id="alert-qs" type="time" bind:value={quietStart} />
          </div>
          <div>
            <label for="alert-qe">{t('workspace:alerts.settings.quietTo')}</label>
            <input id="alert-qe" type="time" bind:value={quietEnd} />
          </div>
          <div>
            <label for="alert-tz">{t('workspace:alerts.settings.timeZone')}</label>
            <input id="alert-tz" type="text" bind:value={timezone} placeholder={browserTimeZone()} autocomplete="off" spellcheck="false" />
          </div>
        </div>
        <p class="hint">{t('workspace:alerts.settings.quietHint')}</p>
      </fieldset>

      <div class="field">
        <label for="alert-digest">{t('workspace:alerts.settings.digest')}</label>
        <div class="row wrap">
          <select id="alert-digest" bind:value={digest}>
            <option value="off">{t('workspace:alerts.settings.digestOff')}</option>
            <option value="daily">{t('workspace:alerts.settings.digestDaily')}</option>
            <option value="weekly">{t('workspace:alerts.settings.digestWeekly')}</option>
          </select>
          {#if digest !== 'off'}
            <label class="check" for="alert-digest-hour">
              {t('workspace:alerts.settings.digestAt')}
              <select id="alert-digest-hour" bind:value={digestHour}>
                {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<option value={h}>{minutesToTime(h * 60)}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
        <p class="hint">{t('workspace:alerts.settings.digestHint')}</p>
      </div>

      {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}
      {#if saved}<Alert tone="ok">{saved}</Alert>{/if}
      <div><Button type="submit" variant="primary" loading={saving}>{t('workspace:alerts.settings.save')}</Button></div>
    </form>
  </Section>

  <Section title={t('workspace:alerts.settings.tryTitle')} key="alerts-test" defaultOpen={false} summary={t('workspace:alerts.settings.trySummary')}>
    <div class="stack">
      <p class="muted">{t('workspace:alerts.settings.tryIntro')}</p>
      <div class="row wrap">
        {#each personalChannels as c (c)}
          <Button loading={testing === c} onclick={() => test(c)}>{c === 'in_app' ? t('workspace:alerts.settings.testSendInApp') : c === 'email' ? t('workspace:alerts.settings.testSendEmail') : t('workspace:alerts.settings.testSendDesktop')}</Button>
        {/each}
      </div>
      <p class="hint" role="status">
        {desktopShell ? t('workspace:alerts.settings.desktopStatusApp', { state: t(notifyStateKeys[notify]) }) : t('workspace:alerts.settings.desktopStatusBrowser', { state: t(notifyStateKeys[notify]) })}
        {#if notify === 'default'}<button type="button" class="linklike" onclick={askDesktop}>{t('workspace:alerts.settings.allow')}</button>{/if}
        {t('workspace:alerts.settings.deviceSwitchNote')}
      </p>
      {#if testError}<Alert tone="error">{testError}</Alert>{/if}
      {#if testResult}
        <ul class="plain" aria-label={t('workspace:alerts.settings.testResult')}>
          {#each testResult.deliveries as d (d.id)}
            <li>
              <Badge tone={statusTone(d.status)}>{statusLabel(d.status)}</Badge>
              {t('workspace:alerts.settings.testLine', { channel: channelLabel(d.channel), outcome: describeOutcome(d.outcome) })}
            </li>
          {:else}
            <li>{testResult.channel === 'in_app' ? t('workspace:alerts.settings.notOnInApp') : testResult.channel === 'email' ? t('workspace:alerts.settings.notOnEmail') : t('workspace:alerts.settings.notOnDesktop')}</li>
          {/each}
        </ul>
        {#if testResult.channel === 'desktop'}
          <p class="muted" data-testid="desktop-test-outcome">{desktopOutcomeText(alertStore.notifyOutcome)}</p>
        {/if}
      {/if}
    </div>
  </Section>

  <Section title={t('workspace:alerts.settings.matrixTitle')} key="alerts-matrix" summary={appId === null ? t('workspace:alerts.settings.allApps') : appName(appId)}>
    <div class="stack">
      <div class="field">
        <label for="alert-scope">{t('workspace:alerts.settings.scopeLabel')}</label>
        <select id="alert-scope" bind:value={scopeApp}>
          <option value="">{t('workspace:alerts.settings.scopeAll')}</option>
          {#each apps as a (a.id)}<option value={a.id}>{t('workspace:alerts.settings.scopeOnly', { name: a.name })}</option>{/each}
        </select>
        <p class="hint">{t('workspace:alerts.settings.scopeHint')}</p>
      </div>
      {#if matrixError}<Alert tone="error">{matrixError}</Alert>{/if}
      {#each groups as g (g.id)}
        <Section title={g.label} key={`alerts-matrix-${g.id}`} count={g.entries.length} variant="plain" level={4} flush>
          <div class="table-wrap">
            <table>
              <caption class="visually-hidden">{t('workspace:alerts.settings.matrixCaption', { group: g.label })}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('workspace:alerts.settings.colAlert')}</th>
                  {#each personalChannels as c (c)}<th scope="col">{channelLabel(c)}</th>{/each}
                  <th scope="col"><span class="visually-hidden">{t('workspace:alerts.settings.colDefault')}</span></th>
                </tr>
              </thead>
              <tbody>
                {#each g.entries as e (e.id)}
                  {@const current = channelsOf(e)}
                  <tr>
                    <th scope="row">
                      <span class="name">{e.label}</span>
                      <Badge tone={severityTone[e.severity]}>{severityLabel(e.severity)}</Badge>
                      <span class="hint">{e.description}</span>
                    </th>
                    {#each personalChannels as c (c)}
                      <td>
                        <input
                          type="checkbox"
                          aria-label={t('workspace:alerts.settings.cellLabel', { alert: e.label, channel: channelLabel(c) })}
                          checked={current.indexOf(c) >= 0}
                          disabled={busyType === e.id || e.allowedChannels.indexOf(c) < 0}
                          onchange={(ev) => choose(e, c, ev.currentTarget.checked)}
                        />
                      </td>
                    {/each}
                    <td>
                      {#if own(e.id)}
                        <button type="button" class="linklike" disabled={busyType === e.id} onclick={() => useDefault(e)}>{t('workspace:alerts.settings.useDefault')}</button>
                      {:else}
                        <span class="muted">{t('workspace:alerts.settings.colDefault')}</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Section>
      {:else}
        <p class="muted">{t('workspace:alerts.settings.noAlerts')}</p>
      {/each}
    </div>
  </Section>

  <Section title={t('workspace:alerts.settings.mutesTitle')} key="alerts-mutes" count={page.mutes.length} defaultOpen={page.mutes.length > 0}>
    <div class="stack">
      {#if page.mutes.length === 0}
        <p class="muted">{t('workspace:alerts.settings.noMutes')}</p>
      {:else}
        <ul class="plain">
          {#each page.mutes as m (m.id)}
            <li class="row between">
              <span>{t('workspace:alerts.settings.muteLine', { what: muteLabel(m, appName, typeLabel), until: muteUntil(m) })}</span>
              <Button size="sm" variant="ghost" loading={muteBusy === m.id} onclick={() => removeMute(m)}>{t('workspace:alerts.settings.turnBackOn')}</Button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="row wrap" onsubmit={addMute}>
        <div>
          <label for="mute-type">{t('workspace:alerts.settings.muteAlert')}</label>
          <select id="mute-type" bind:value={muteType}>
            <option value="">{t('workspace:alerts.settings.muteAllAlerts')}</option>
            {#each catalog.filter((e) => e.visible) as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
          </select>
        </div>
        <div>
          <label for="mute-app">{t('workspace:alerts.settings.muteApp')}</label>
          <select id="mute-app" bind:value={muteApp}>
            <option value="">{t('workspace:alerts.settings.muteEveryApp')}</option>
            {#each apps as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
          </select>
        </div>
        <div>
          <label for="mute-for">{t('workspace:alerts.settings.muteFor')}</label>
          <select id="mute-for" bind:value={muteFor}>
            {#each snoozeChoices as c, i (c.labelKey)}<option value={String(i)}>{t(c.labelKey)}</option>{/each}
          </select>
        </div>
        <Button type="submit" loading={muteBusy === 'add'}>{t('workspace:alerts.settings.mute')}</Button>
      </form>
      {#if muteError}<Alert tone="error">{muteError}</Alert>{/if}
    </div>
  </Section>
</div>

<style>
  th[scope='row'] {
    font-weight: var(--weight-regular);
    text-align: left;
  }
  th[scope='row'] .name {
    font-weight: var(--weight-semibold);
    margin-right: var(--space-2);
  }
  th[scope='row'] .hint {
    display: block;
    margin: var(--space-1) 0 0;
  }
  td {
    text-align: center;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .plain li {
    padding: var(--space-1) 0;
  }
  .linklike {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }
  .linklike:disabled {
    color: var(--muted);
    cursor: default;
  }
  fieldset {
    border: 0;
    padding: 0;
    margin: 0;
  }
  legend {
    padding: 0;
    font-weight: var(--weight-medium);
    margin-bottom: var(--space-1);
  }
</style>
