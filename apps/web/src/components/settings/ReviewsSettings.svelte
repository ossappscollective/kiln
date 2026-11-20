<!--
  ReviewsSettings: the low rating threshold, and the reminder for reviews nobody answered.
  Props: form (bindable), editable, error?, errors?, writable? (the keys the caller may write). The threshold decides which new reviews raise the
  `review.new_low_rating` event and show "Low rating". It applies from the next sync on and never
  re-sends events for reviews that were already read.
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, canEdit } from '../../lib/settings.ts';
  import Card from '../ui/Card.svelte';

  let {
    form = $bindable(),
    editable,
    error,
    errors = {},
    writable = [],
  }: { form: SettingsForm; editable: boolean; error?: string | undefined; errors?: FormErrors | undefined; writable?: readonly string[] | undefined } = $props();

  const uid = $props.id();
  /** The reminder keys follow the right to change settings and the server's list of writable keys. */
  const canRemind = (key: string): boolean => canEdit(writable, key);
</script>

<Card title="Reviews" collapseKey="reviews" description="Which reviews count as low.">
  <div class="field">
    <label for="{uid}-threshold">Low rating threshold</label>
    <select id="{uid}-threshold" bind:value={form.lowRatingThreshold} disabled={!editable} aria-describedby="{uid}-threshold-hint" aria-invalid={error ? 'true' : undefined}>
      <option value="1">1 star</option>
      <option value="2">2 stars or fewer (default)</option>
      <option value="3">3 stars or fewer</option>
      <option value="4">4 stars or fewer</option>
    </select>
    <p class="hint" id="{uid}-threshold-hint">
      Reviews at or below this are marked Low rating and raise an alert. A change applies from the next sync, and not to reviews already read.
    </p>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-reminder">Remind me about unanswered reviews after (hours)</label>
    <input
      id="{uid}-reminder"
      type="text"
      inputmode="numeric"
      autocomplete="off"
      bind:value={form.unansweredReminderHours}
      disabled={!canRemind(KEYS.unansweredReminderHours)}
      aria-describedby="{uid}-reminder-hint"
      aria-invalid={errors.unansweredReminderHours ? 'true' : undefined}
    />
    <p class="hint" id="{uid}-reminder-hint">
      One reminder at most this often. 0 is off (the default).
    </p>
    {#if errors.unansweredReminderHours}<p class="field-error" role="alert">{errors.unansweredReminderHours}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-maxrating">Count unanswered reviews rated at or below</label>
    <select
      id="{uid}-maxrating"
      bind:value={form.unansweredMaxRating}
      disabled={!canRemind(KEYS.unansweredMaxRating)}
      aria-describedby="{uid}-maxrating-hint"
      aria-invalid={errors.unansweredMaxRating ? 'true' : undefined}
    >
      <option value="1">1 star</option>
      <option value="2">2 stars or fewer</option>
      <option value="3">3 stars or fewer</option>
      <option value="4">4 stars or fewer</option>
      <option value="5">5 stars (every review, the default)</option>
    </select>
    <p class="hint" id="{uid}-maxrating-hint">Used by the reminder, the unanswered badge and the “Show unanswered” list.</p>
    {#if errors.unansweredMaxRating}<p class="field-error" role="alert">{errors.unansweredMaxRating}</p>{/if}
  </div>
</Card>
