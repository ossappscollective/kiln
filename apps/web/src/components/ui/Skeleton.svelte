<!--
  Skeleton: a loading placeholder block.
  Props: width = '100%', height = '1em' (any CSS length), circle (round), class?.
  Hidden from assistive technology; put a role="status" label on the container that is loading.
-->
<script lang="ts">
  let {
    width = '100%',
    height = '1em',
    circle = false,
    class: className = '',
  }: { width?: string | undefined; height?: string | undefined; circle?: boolean | undefined; class?: string | undefined } = $props();
</script>

<span class="skeleton {className}" class:circle style:width style:height aria-hidden="true"></span>
