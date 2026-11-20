<script lang="ts">
  import AuthCard from './AuthCard.svelte';
  import Button from './ui/Button.svelte';

  let { onretry }: { onretry: () => void } = $props();
</script>

<AuthCard
  title="Open this app from the desktop shell"
  subtitle="This server runs in single-user mode and has no sign-in page."
>
  <div class="stack">
    <p>
      Start Mobile Release Manager from its desktop app. The app opens this page with a one-time
      key that signs you in. A browser tab or a bookmark cannot do that.
    </p>
    <p class="quiet">If you just closed the window, quit the desktop app and start it again.</p>
    <Button variant="primary" size="lg" block icon="refresh" onclick={onretry}>Check again</Button>
  </div>
</AuthCard>
