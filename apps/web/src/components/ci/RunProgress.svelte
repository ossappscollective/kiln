<!--
  RunProgress: how far a run in progress has got, as a thin bar and a line that says where it is
  (the job and step now). A run that has not started, or whose jobs are not known, has no bar, only
  the line. The bar is for the eye; the line and the progressbar role carry the same information.
  Props: percent (0 to 100, or null), label (what the run is doing), name (accessible name of the bar,
  for example the workflow).
-->
<script lang="ts">
  let { percent, label, name }: { percent: number | null; label: string; name: string } = $props();
</script>

<div class="progress">
  {#if percent !== null}
    <div class="bar" role="progressbar" aria-label="Progress of {name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow={percent}>
      <span class="fill" style:width="{percent}%"></span>
    </div>
  {/if}
  {#if label}<span class="label muted text-sm">{label}{#if percent !== null}<span class="num"> · {percent}%</span>{/if}</span>{/if}
</div>

<style>
  .progress {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    min-width: 0;
  }

  .bar {
    flex: 0 0 120px;
    height: var(--space-1);
    overflow: hidden;
    background: var(--line);
    border-radius: var(--radius-full);
  }

  .fill {
    display: block;
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-full);
    transition: width var(--duration-slow) var(--ease);
  }

  .label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
