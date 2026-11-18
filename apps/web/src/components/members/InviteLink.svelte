<script lang="ts">
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
  <h3 id="invite-link-title">Invitation link for {email}</h3>
  <Alert tone="warn" title="Copy this link now. It is shown only once.">
    Anyone with the link can join the workspace as this person, so send it privately. It works once
    and expires in 7 days. Lost it? Revoke the invitation and make a new one.
  </Alert>
  <div class="row">
    <label class="visually-hidden" for="invite-link">One-time invitation link</label>
    <input id="invite-link" value={link} readonly onfocus={(e) => e.currentTarget.select()} />
    <CopyButton value={link} label="Copy link" variant="secondary" size="md" />
  </div>
  <div class="row">
    <Button onclick={ondismiss}>I have copied it</Button>
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
