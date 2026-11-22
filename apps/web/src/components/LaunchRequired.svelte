<script lang="ts">
  import AuthCard from './AuthCard.svelte';
  import Button from './ui/Button.svelte';
  import { t } from '../lib/i18n/t.ts';

  let { onretry }: { onretry: () => void } = $props();
</script>

<AuthCard
  title={t('auth:launch.title')}
  subtitle={t('auth:launch.subtitle')}
>
  <div class="stack">
    <p>{t('auth:launch.body')}</p>
    <p class="quiet">{t('auth:launch.hint')}</p>
    <Button variant="primary" size="lg" block icon="refresh" onclick={onretry}>{t('auth:launch.retry')}</Button>
  </div>
</AuthCard>
