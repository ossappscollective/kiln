<!--
  ReviewsSettings: the low rating threshold.
  Props: form (bindable), editable, error?. The threshold decides which new reviews raise the
  `review.new_low_rating` event and show "Low rating". It applies from the next sync on and never
  re-sends events for reviews that were already read.
-->
<script lang="ts">
  import type { SettingsForm } from '../../lib/settings.ts';
  import Card from '../ui/Card.svelte';

  let { form = $bindable(), editable, error }: { form: SettingsForm; editable: boolean; error?: string | undefined } = $props();

  const uid = $props.id();
</script>

<Card title="Reviews" description="Which reviews count as low.">
  <div class="field">
    <label for="{uid}-threshold">Low rating threshold</label>
    <select id="{uid}-threshold" bind:value={form.lowRatingThreshold} disabled={!editable} aria-describedby="{uid}-threshold-hint" aria-invalid={error ? 'true' : undefined}>
      <option value="1">1 star</option>
      <option value="2">2 stars or fewer (default)</option>
      <option value="3">3 stars or fewer</option>
      <option value="4">4 stars or fewer</option>
    </select>
    <p class="hint" id="{uid}-threshold-hint">
      New reviews at or below this rating raise the “new low rating” event and are marked Low rating. A change applies from the next
      sync. Raising it does not send events for reviews that were already read; only reviews first seen from then on, or whose rating
      changes, count.
    </p>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>
</Card>
