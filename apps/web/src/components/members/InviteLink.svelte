<script lang="ts">
  import { t } from '../../lib/i18n/t.ts';
  import Alert from '../ui/Alert.svelte';
  import Button from '../ui/Button.svelte';
  import CopyButton from '../ui/CopyButton.svelte';
  import { inviteLink } from './links.ts';

  let {
    token,
    email,
    ondismiss,
  }: { token: string; email: string; ondismiss: () => void } = $props();

  const link = $derived(inviteLink(location.origin, token));
</script>

<div class="card box" role="region" aria-labelledby="invite-link-title">
  <h3 id="invite-link-title">{t('workspace:members.link.title', { email })}</h3>
  <Alert tone="warn" title={t('workspace:members.link.warnTitle')}>
    {t('workspace:members.link.warnBody')}
  </Alert>
  <div class="row">
    <label class="visually-hidden" for="invite-link">{t('workspace:members.link.label')}</label>
    <input id="invite-link" value={link} readonly onfocus={(e) => e.currentTarget.select()} />
    <CopyButton value={link} label={t('workspace:members.link.copy')} variant="secondary" size="md" />
  </div>
  <div class="row">
    <Button onclick={ondismiss}>{t('workspace:secret.copied')}</Button>
  </div>
</div>

<style>
  .box {
    display: grid;
    gap: 12px;
    border-color: var(--warn-line);
  }

  .row input {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
</style>
