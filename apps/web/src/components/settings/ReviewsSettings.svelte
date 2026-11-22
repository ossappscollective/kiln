<!--
  ReviewsSettings: the low rating threshold, and the reminder for reviews nobody answered.
  Props: form (bindable), editable, error?, errors?, writable? (the keys the caller may write). The threshold decides which new reviews raise the
  `review.new_low_rating` event and show "Low rating". It applies from the next sync on and never
  re-sends events for reviews that were already read.
-->
<script lang="ts">
  import { KEYS, type FormErrors, type SettingsForm, canEdit } from '../../lib/settings.ts';
  import { t } from '../../lib/i18n/t.ts';
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

<Card title={t('settings:reviews.title')} collapseKey="reviews" description={t('settings:reviews.description')}>
  <div class="field">
    <label for="{uid}-threshold">{t('settings:reviews.thresholdLabel')}</label>
    <select id="{uid}-threshold" bind:value={form.lowRatingThreshold} disabled={!editable} aria-describedby="{uid}-threshold-hint" aria-invalid={error ? 'true' : undefined}>
      <option value="1">{t('settings:reviews.star1')}</option>
      <option value="2">{t('settings:reviews.star2Default')}</option>
      <option value="3">{t('settings:reviews.star3')}</option>
      <option value="4">{t('settings:reviews.star4')}</option>
    </select>
    <p class="hint" id="{uid}-threshold-hint">
      {t('settings:reviews.thresholdHint')}
    </p>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-reminder">{t('settings:reviews.reminderLabel')}</label>
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
      {t('settings:reviews.reminderHint')}
    </p>
    {#if errors.unansweredReminderHours}<p class="field-error" role="alert">{errors.unansweredReminderHours}</p>{/if}
  </div>
  <div class="field">
    <label for="{uid}-maxrating">{t('settings:reviews.maxRatingLabel')}</label>
    <select
      id="{uid}-maxrating"
      bind:value={form.unansweredMaxRating}
      disabled={!canRemind(KEYS.unansweredMaxRating)}
      aria-describedby="{uid}-maxrating-hint"
      aria-invalid={errors.unansweredMaxRating ? 'true' : undefined}
    >
      <option value="1">{t('settings:reviews.star1')}</option>
      <option value="2">{t('settings:reviews.star2')}</option>
      <option value="3">{t('settings:reviews.star3')}</option>
      <option value="4">{t('settings:reviews.star4')}</option>
      <option value="5">{t('settings:reviews.star5Default')}</option>
    </select>
    <p class="hint" id="{uid}-maxrating-hint">{t('settings:reviews.maxRatingHint')}</p>
    {#if errors.unansweredMaxRating}<p class="field-error" role="alert">{errors.unansweredMaxRating}</p>{/if}
  </div>
</Card>
