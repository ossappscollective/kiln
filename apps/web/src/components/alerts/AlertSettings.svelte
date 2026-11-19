<!--
  AlertSettings: what one person receives. Three parts: how and when (lowest severity, quiet hours with a time zone, the digest),
  the matrix of alert types by channel (for all apps or one app; "workspace default" until the person chooses), and the mutes and
  snoozes. Test buttons send one alert through one channel and show the result in words. Props: api, workspaceId, catalog, page
  (the person's settings, choices and mutes), apps, onreload (after anything that other tabs also show).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import { alertStore } from '../../lib/alert-store.svelte.ts';
  import { type NotifyState, inDesktopShell, notificationState, notifyStateText, requestNotificationPermission } from '../../lib/alert-notify.ts';
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
    channelLabels,
    describeOutcome,
    effectiveChannels,
    matrixGroups,
    minutesToTime,
    muteLabel,
    personalChannels,
    quietSummary,
    severityLabels,
    severityTone,
    snoozeChoices,
    statusLabels,
    statusTone,
    timeToMinutes,
    toggleChannel,
  } from '../../lib/alerts.ts';
  import { fullTime } from '../../lib/format.ts';
  import Alert from '../ui/Alert.svelte';
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Section from '../ui/Section.svelte';

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
      saveError = 'Write quiet hours as 22:00 (24-hour time).';
      return;
    }
    if ((start === null) !== (end === null)) {
      saveError = 'Give both a start and an end for quiet hours, or leave both empty.';
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
      saved = `Saved. ${quietSummary(result.settings)}.`;
      onreload();
    } catch (e) {
      saveError = e instanceof ApiError ? e.message : 'Could not save your settings.';
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
      testError = e instanceof ApiError ? e.message : 'Could not send the test alert.';
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
      matrixError = err instanceof ApiError ? err.message : 'Could not save that choice.';
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
      matrixError = err instanceof ApiError ? err.message : 'Could not go back to the default.';
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

  const appName = (id: string) => apps.find((a) => a.id === id)?.name ?? 'An app';
  const typeLabel = (id: string) => catalog.find((e) => e.id === id)?.label ?? id;
  const muteUntil = (m: Mute) => (m.until === null ? 'until you turn it back on' : `until ${fullTime(m.until)}`);

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
      muteError = e instanceof ApiError ? e.message : 'Could not mute that.';
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
      muteError = e instanceof ApiError ? e.message : 'Could not remove that mute.';
    } finally {
      muteBusy = '';
    }
  }
</script>

<div class="stack loose">
  <Section title="How and when" key="alerts-how" summary={quietSummary(page.settings)}>
    <form class="stack" onsubmit={saveSettings}>
      <div class="field">
        <label for="alert-min">Lowest severity I want</label>
        <select id="alert-min" bind:value={minSeverity}>
          {#each ['info', 'warning', 'critical'] as s (s)}<option value={s}>{severityLabels[s as AlertSeverity]} and above</option>{/each}
        </select>
        <p class="hint">Applies to email, the inbox and desktop notifications.</p>
      </div>

      <fieldset class="field">
        <legend>Quiet hours</legend>
        <div class="row wrap">
          <div>
            <label for="alert-qs">From</label>
            <input id="alert-qs" type="time" bind:value={quietStart} />
          </div>
          <div>
            <label for="alert-qe">To</label>
            <input id="alert-qe" type="time" bind:value={quietEnd} />
          </div>
          <div>
            <label for="alert-tz">Time zone</label>
            <input id="alert-tz" type="text" bind:value={timezone} placeholder={browserTimeZone()} autocomplete="off" spellcheck="false" />
          </div>
        </div>
        <p class="hint">
          Emails wait until quiet hours end and desktop notifications are not shown. Critical alerts still come through. Leave both times
          empty for no quiet hours.
        </p>
      </fieldset>

      <div class="field">
        <label for="alert-digest">Email digest</label>
        <div class="row wrap">
          <select id="alert-digest" bind:value={digest}>
            <option value="off">Off: send each email at once</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly (Mondays)</option>
          </select>
          {#if digest !== 'off'}
            <label class="check" for="alert-digest-hour">
              at
              <select id="alert-digest-hour" bind:value={digestHour}>
                {#each Array.from({ length: 24 }, (_, h) => h) as h (h)}<option value={h}>{minutesToTime(h * 60)}</option>{/each}
              </select>
            </label>
          {/if}
        </div>
        <p class="hint">With a digest, emails for alerts below critical are collected into one message. Critical alerts are still sent at once.</p>
      </div>

      {#if saveError}<Alert tone="error">{saveError}</Alert>{/if}
      {#if saved}<Alert tone="ok">{saved}</Alert>{/if}
      <div><Button type="submit" variant="primary" loading={saving}>Save</Button></div>
    </form>
  </Section>

  <Section title="Try it" key="alerts-test" summary="Send a test alert to yourself">
    <div class="stack">
      <p class="muted">A test alert goes through the same path as a real one, so you see what would happen: delivered, held back, or why not.</p>
      <div class="row wrap">
        {#each personalChannels as c (c)}
          <Button loading={testing === c} onclick={() => test(c)}>Send a test {channelLabels[c].toLowerCase()}</Button>
        {/each}
      </div>
      <p class="hint" role="status">
        Desktop notifications{desktopShell ? ' (desktop app)' : ' (this browser)'}: {notifyStateText[notify]}
        {#if notify === 'default'}<button type="button" class="linklike" onclick={askDesktop}>Allow notifications</button>{/if}
      </p>
      {#if testError}<Alert tone="error">{testError}</Alert>{/if}
      {#if testResult}
        <ul class="plain" aria-label="Test result">
          {#each testResult.deliveries as d (d.id)}
            <li>
              <Badge tone={statusTone(d.status)}>{statusLabels[d.status] ?? d.status}</Badge>
              {channelLabels[d.channel]}: {describeOutcome(d.outcome)}
            </li>
          {:else}
            <li>Nothing was sent: {channelLabels[testResult.channel].toLowerCase()} is not on for you.</li>
          {/each}
        </ul>
      {/if}
    </div>
  </Section>

  <Section title="What I receive" key="alerts-matrix" summary={appId === null ? 'All apps' : appName(appId)}>
    <div class="stack">
      <div class="field">
        <label for="alert-scope">Choices apply to</label>
        <select id="alert-scope" bind:value={scopeApp}>
          <option value="">All apps (and workspace alerts)</option>
          {#each apps as a (a.id)}<option value={a.id}>{a.name} only</option>{/each}
        </select>
        <p class="hint">A choice for one app wins over your choice for all apps. Until you choose, the workspace default applies.</p>
      </div>
      {#if matrixError}<Alert tone="error">{matrixError}</Alert>{/if}
      {#each groups as g (g.id)}
        <Section title={g.label} key={`alerts-matrix-${g.id}`} count={g.entries.length} variant="plain" level={4} flush>
          <div class="table-wrap">
            <table>
              <caption class="visually-hidden">{g.label}: where each alert is delivered</caption>
              <thead>
                <tr>
                  <th scope="col">Alert</th>
                  {#each personalChannels as c (c)}<th scope="col">{channelLabels[c]}</th>{/each}
                  <th scope="col"><span class="visually-hidden">Default</span></th>
                </tr>
              </thead>
              <tbody>
                {#each g.entries as e (e.id)}
                  {@const current = channelsOf(e)}
                  <tr>
                    <th scope="row">
                      <span class="name">{e.label}</span>
                      <Badge tone={severityTone[e.severity]}>{severityLabels[e.severity]}</Badge>
                      <span class="hint">{e.description}</span>
                    </th>
                    {#each personalChannels as c (c)}
                      <td>
                        <input
                          type="checkbox"
                          aria-label="{e.label}: {channelLabels[c]}"
                          checked={current.indexOf(c) >= 0}
                          disabled={busyType === e.id || e.allowedChannels.indexOf(c) < 0}
                          onchange={(ev) => choose(e, c, ev.currentTarget.checked)}
                        />
                      </td>
                    {/each}
                    <td>
                      {#if own(e.id)}
                        <button type="button" class="linklike" disabled={busyType === e.id} onclick={() => useDefault(e)}>Use default</button>
                      {:else}
                        <span class="muted">Default</span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </Section>
      {:else}
        <p class="muted">No alerts to choose from here.</p>
      {/each}
    </div>
  </Section>

  <Section title="Muted and snoozed" key="alerts-mutes" count={page.mutes.length}>
    <div class="stack">
      {#if page.mutes.length === 0}
        <p class="muted">Nothing is muted.</p>
      {:else}
        <ul class="plain">
          {#each page.mutes as m (m.id)}
            <li class="row between">
              <span>{muteLabel(m, appName, typeLabel)}, {muteUntil(m)}</span>
              <Button size="sm" variant="ghost" loading={muteBusy === m.id} onclick={() => removeMute(m)}>Turn back on</Button>
            </li>
          {/each}
        </ul>
      {/if}
      <form class="row wrap" onsubmit={addMute}>
        <div>
          <label for="mute-type">Alert</label>
          <select id="mute-type" bind:value={muteType}>
            <option value="">All alerts</option>
            {#each catalog.filter((e) => e.visible) as e (e.id)}<option value={e.id}>{e.label}</option>{/each}
          </select>
        </div>
        <div>
          <label for="mute-app">App</label>
          <select id="mute-app" bind:value={muteApp}>
            <option value="">Every app</option>
            {#each apps as a (a.id)}<option value={a.id}>{a.name}</option>{/each}
          </select>
        </div>
        <div>
          <label for="mute-for">For</label>
          <select id="mute-for" bind:value={muteFor}>
            {#each snoozeChoices as c, i (c.label)}<option value={String(i)}>{c.label}</option>{/each}
          </select>
        </div>
        <Button type="submit" loading={muteBusy === 'add'}>Mute</Button>
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
