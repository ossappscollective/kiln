<script lang="ts">
  // A small "working" ring. It is decoration: say what is happening in text next to it.
</script>

<span class="spinner" aria-hidden="true"></span>

<style>
  .spinner {
    display: inline-block;
    flex: none;
    width: 1em;
    height: 1em;
    vertical-align: -0.15em;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* No motion: a still, broken ring still reads as "working". */
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
