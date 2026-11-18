<!--
  RolloutControls: where the store rollout controls will be (docs/ux-ia.md, section 5). A visible
  placeholder: the controls are shown disabled, because they change the live store and are not wired
  yet. They need MRM_STORE_ROLLOUT_ENABLED on the server. The rollout PLAN (steps, planned times,
  confirm from the store) is planning data and works today, in the detail of each release row.
  No props.
-->
<script lang="ts">
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  const uid = $props.id();
  const reason = 'Needs MRM_STORE_ROLLOUT_ENABLED. The controls are wired later.';
</script>

<section class="controls card" aria-labelledby="{uid}-title">
  <div class="head">
    <h3 id="{uid}-title"><Icon name="rocket" size={16} /> Rollout controls</h3>
    <Badge tone="neutral" icon="lock">Disabled</Badge>
  </div>
  <p class="muted note">
    Changing a rollout in the store (increase the Google Play staged rollout, halt, resume, release to 100%, or
    pause and resume an Apple phased release) changes the live store. These controls are off: they need
    <code>MRM_STORE_ROLLOUT_ENABLED</code> on the server, and they are wired later. Each one will ask for
    confirmation and be recorded in the audit log. The rollout plan in each release row is planning data and
    does not touch a store.
  </p>
  <div class="row wrap">
    <Button size="sm" disabled title={reason}>Increase rollout…</Button>
    <Button size="sm" disabled title={reason}>Halt</Button>
    <Button size="sm" disabled title={reason}>Resume</Button>
    <Button size="sm" disabled title={reason}>Release to 100%</Button>
    <Button size="sm" disabled title={reason}>Pause phased release</Button>
  </div>
</section>

<style>
  .controls {
    border-style: dashed;
    opacity: 0.85;
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-3);
    align-items: center;
  }

  h3 {
    display: inline-flex;
    gap: var(--space-2);
    align-items: center;
    margin: 0;
    font-size: var(--text-md);
  }

  .note {
    margin: var(--space-2) 0 var(--space-3);
    font-size: var(--text-sm);
  }
</style>
