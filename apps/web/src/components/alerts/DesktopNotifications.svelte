<!--
  DesktopNotifications: one switch for this device and the kinds of alert that may show a desktop notification (docs/alerts.md#desktop-notifications).
  The switch is per device (the browser or the desktop app asks its own permission, and only when the person turns the switch on, never on load).
  The kinds are the person's own choice per alert type for all apps (the same choice as the Desktop notification column below). A notification
  shows the alert's title only, and only while the app is open. Props: api, workspaceId, catalog, prefs (bindable, shared with the matrix), notify (bindable permission state).
-->
<script lang="ts">
  import { ApiError, type Api } from '../../lib/api.ts';
  import {
    desktopKindEntries,
    deviceEnabled,
    kindUsesDesktop,
    readDeviceChoice,
    writeDeviceChoice,
  } from '../../lib/alert-desktop.ts';
  import { type NotifyState, inDesktopShell, notifyStateText, requestNotificationPermission } from '../../lib/alert-notify.ts';
  import { type CatalogEntry, type Preference, effectiveChannels, toggleChannel } from '../../lib/alerts.ts';
  import Alert from '../ui/Alert.svelte';
  import Section from '../ui/Section.svelte';

  let {
    api,
    workspaceId,
    catalog,
    prefs = $bindable(),
    notify = $bindable(),
  }: { api: Api; workspaceId: string; catalog: CatalogEntry[]; prefs: Preference[]; notify: NotifyState } = $props();

  const uid = $props.id();
  const shell = inDesktopShell();
  const storage = typeof localStorage === 'undefined' ? undefined : localStorage;
  let choice = $state<boolean | null>(readDeviceChoice(storage));
  let error = $state('');
  let busy = $state('');

  const on = $derived(deviceEnabled(choice, notify));
  const kinds = $derived(desktopKindEntries(catalog));
  const chosen = $derived(kinds.filter((e) => kindUsesDesktop(e, prefs)).length);

  async function toggleDevice(checked: boolean) {
    error = '';
    if (!checked) {
      writeDeviceChoice(storage, false);
      choice = false;
      return;
    }
    // Asked here, from the click, and only here.
    if (notify !== 'granted') notify = await requestNotificationPermission();
    if (notify === 'granted') {
      writeDeviceChoice(storage, true);
      choice = true;
    } else {
      error = notifyStateText[notify];
    }
  }

  async function chooseKind(e: CatalogEntry, checked: boolean) {
    error = '';
    busy = e.id;
    try {
      const channels = toggleChannel(effectiveChannels(e, prefs, e.id, null), 'desktop', checked);
      const result = await api.setAlertPreference(workspaceId, e.id, { appId: null, channels });
      const rest = prefs.filter((p) => !(p.alertType === e.id && p.appId === null));
      prefs = result.preference ? rest.concat([result.preference]) : rest;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Could not save that choice.';
    } finally {
      busy = '';
    }
  }
</script>

<Section title="Desktop notifications" key="alerts-desktop" summary={on ? `On for this device, ${chosen} kind${chosen === 1 ? '' : 's'}` : 'Off for this device'}>
  <div class="stack">
    <div class="field">
      <label class="check" for="{uid}-device">
        <input
          id="{uid}-device"
          type="checkbox"
          checked={on}
          disabled={notify === 'unsupported' || notify === 'denied'}
          aria-describedby="{uid}-device-hint"
          onchange={(ev) => toggleDevice(ev.currentTarget.checked)}
        />
        Show desktop notifications on this device ({shell ? 'desktop app' : 'this browser'})
      </label>
      <p class="hint" id="{uid}-device-hint" role="status">
        {notifyStateText[notify]} Shows the alert's title only, while this app is open, and follows your quiet hours.
      </p>
    </div>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    {#if kinds.length > 0}
      <fieldset class="field">
        <legend>Notify me when</legend>
        {#each kinds as e (e.id)}
          <label class="check" for="{uid}-{e.id}">
            <input
              id="{uid}-{e.id}"
              type="checkbox"
              checked={kindUsesDesktop(e, prefs)}
              disabled={busy === e.id}
              onchange={(ev) => chooseKind(e, ev.currentTarget.checked)}
            />
            {e.label}
          </label>
        {/each}
        <p class="hint">
          For all apps. “What I receive” below has every kind and a choice per app.
        </p>
      </fieldset>
    {/if}
  </div>
</Section>
