<!--
  StagedTray: the place where staged listing changes will collect (docs/ux-ia.md, section 4). It is
  a placeholder: visible so the model is clear, disabled because nothing is staged yet and nothing
  here pushes to a store. It arrives with draft push.
  No props.
-->
<script lang="ts">
  import Badge from '../ui/Badge.svelte';
  import Button from '../ui/Button.svelte';
  import Icon from '../ui/Icon.svelte';

  const uid = $props.id();
</script>

<section class="tray card" aria-labelledby="{uid}-title">
  <div class="head">
    <h3 id="{uid}-title"><Icon name="layers" size={16} /> Staged changes</h3>
    <Badge tone="neutral">Arrives with draft push</Badge>
    <span class="spacer"></span>
    <Button size="sm" icon="upload" disabled title="Available when draft push is built">Push draft to store</Button>
  </div>
  <p class="muted note">
    Edits to listing fields will collect here, one tray per app, and be pushed to the store as a draft in one
    batch. Pushing is separate from submitting for review. Nothing is staged today: this view only reads, and
    changes go to the repository through change sets.
  </p>
</section>

<style>
  .tray {
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

  .spacer {
    flex: 1;
  }

  .note {
    margin: var(--space-2) 0 0;
    font-size: var(--text-sm);
  }
</style>
