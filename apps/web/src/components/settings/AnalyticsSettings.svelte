<!--
  AnalyticsSettings: the workspace's analytics settings (docs/api/analytics.md, docs/api/settings.md), written with
  `analytics.manage` (owners and admins), saved with the other settings.
  - "Read analytics from the stores" (`analytics.enabled`, off by default): syncing, the scheduled job and the Apple enable action
    need it. Reading what is stored and importing a report file do not.
  - The Apple vendor number (`analytics.appleVendorNumber`, 5 to 12 digits): adds daily units and proceeds per currency.
  - The Play Console reports bucket (`analytics.playBucketId`): adds installs and ratings. Set for the whole workspace; a bucket
    per app has no route yet, so this screen does not offer one.
  How often it syncs is the server's setting (MRM_ANALYTICS_INTERVAL_MINUTES), not a workspace setting; the Analytics section of an
  app shows the interval in use.
  Props: form (bindable), editable, errors, writable (the keys the caller may write).
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, canEdit } from '../../lib/settings.ts';
  import Card from '../ui/Card.svelte';

  let { form = $bindable(), editable, errors, writable }: { form: SettingsForm; editable: boolean; errors: FormErrors; writable: readonly string[] } = $props();

  const uid = $props.id();
  const can = (key: string): boolean => editable && canEdit(writable, key);
</script>

<Card title="Analytics" collapseKey="analytics" description="Daily numbers for your apps from the stores. Off until an owner or an admin turns it on.">
  <div class="field">
    <label class="check" for="{uid}-enabled">
      <input id="{uid}-enabled" type="checkbox" bind:checked={form.analyticsEnabled} disabled={!can(KEYS.analyticsEnabled)} aria-describedby="{uid}-enabled-hint" />
      Read analytics from the stores
    </label>
    <p class="hint" id="{uid}-enabled-hint">
      Reads impressions, product page views, downloads, crashes and sales from App Store Connect, and crash rates, installs and ratings from Google
      Play, and keeps them on this server. It only reads; creating the Apple report request is a separate step with a preview and a confirmation,
      in the Analytics section of an app. Numbers already stored stay readable when this is off, and importing a report file works either way.
    </p>
  </div>
  <div class="field">
    <label for="{uid}-vendor">Apple vendor number (optional)</label>
    <input
      id="{uid}-vendor"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      spellcheck="false"
      bind:value={form.analyticsVendorNumber}
      disabled={!can(KEYS.analyticsVendorNumber)}
      aria-describedby="{uid}-vendor-hint"
      aria-invalid={errors.analyticsVendorNumber ? 'true' : undefined}
    />
    <p class="hint" id="{uid}-vendor-hint">
      5 to 12 digits, shown in App Store Connect under Payments and Financial Reports. With it, daily units and proceeds per currency are read from
      Sales and Trends. Empty: no sales numbers.
    </p>
    {#if errors.analyticsVendorNumber}<p class="field-error" role="alert">{errors.analyticsVendorNumber}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-bucket">Play Console reports bucket (optional)</label>
    <input
      id="{uid}-bucket"
      type="text"
      autocomplete="off"
      spellcheck="false"
      bind:value={form.analyticsBucketId}
      disabled={!can(KEYS.analyticsBucketId)}
      aria-describedby="{uid}-bucket-hint"
      aria-invalid={errors.analyticsBucketId ? 'true' : undefined}
    />
    <p class="hint" id="{uid}-bucket-hint">
      The Cloud Storage bucket of the monthly Play Console reports, like pubsite_prod_rev_01234567890123456789 (a gs:// address is accepted). The
      service account needs read access to it. With it, installs and ratings are read. It applies to every Android app in the workspace.
    </p>
    {#if errors.analyticsBucketId}<p class="field-error" role="alert">{errors.analyticsBucketId}</p>{/if}
  </div>
  <p class="hint">
    How often analytics syncs is set by the server (MRM_ANALYTICS_INTERVAL_MINUTES: every 6 hours by default, 0 for never), not here. The Analytics
    section of an app shows the interval in use and when each source was last read.
  </p>
</Card>
