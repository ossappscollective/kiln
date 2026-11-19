<!--
  ReleaseSettings: when a release counts as left unfinished (docs/api/release-pipeline.md, docs/api/settings.md).
  Props: form (bindable), editable (the right to change settings; per key `canEdit`), errors, writable (the keys the caller may write).
  `release.stalledAfterHours` is how long a release may stand still before it is "stalled" and raises `release.stalled`; 0 turns the
  signal off (the pipeline is still shown). `release.stalledRepeatHours` is when the same stall is reminded again; 0 reminds once.
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, canEdit } from '../../lib/settings.ts';
  import Card from '../ui/Card.svelte';

  let { form = $bindable(), editable, errors, writable }: { form: SettingsForm; editable: boolean; errors: FormErrors; writable: readonly string[] } = $props();

  const uid = $props.id();
  const can = (key: string): boolean => editable && canEdit(writable, key);
</script>

<Card title="Releases" collapseKey="releases" description="When a release counts as left unfinished.">
  <div class="field">
    <label for="{uid}-after">Remind me when a release stands still for (hours)</label>
    <input
      id="{uid}-after"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      bind:value={form.stalledAfterHours}
      disabled={!can(KEYS.stalledAfterHours)}
      aria-describedby="{uid}-after-hint"
      aria-invalid={errors.stalledAfterHours ? 'true' : undefined}
    />
    <p class="hint" id="{uid}-after-hint">
      A release that was started but not finished, for example a build that was never chosen or an approved version nobody released, is
      shown as “Release left unfinished” after this many hours. 0 turns the reminder off; the release steps are still shown.
    </p>
    {#if errors.stalledAfterHours}<p class="field-error" role="alert">{errors.stalledAfterHours}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-repeat">Remind again after (hours)</label>
    <input
      id="{uid}-repeat"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      bind:value={form.stalledRepeatHours}
      disabled={!can(KEYS.stalledRepeatHours)}
      aria-describedby="{uid}-repeat-hint"
      aria-invalid={errors.stalledRepeatHours ? 'true' : undefined}
    />
    <p class="hint" id="{uid}-repeat-hint">The same stall is reminded again after this many hours. 0 reminds once and never again.</p>
    {#if errors.stalledRepeatHours}<p class="field-error" role="alert">{errors.stalledRepeatHours}</p>{/if}
  </div>
</Card>
