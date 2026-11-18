<!--
  Button: the global button styles as a component.
  Props: variant = 'secondary' | 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'link',
  size = 'md' | 'sm' | 'lg', icon? (leading icon name), iconOnly (square button; give `label`),
  label? (accessible name for icon-only buttons), loading (shows a spinner, blocks clicks),
  block (full width), href? (renders a link styled as a button), plus any button attribute
  (type defaults to 'button', onclick, disabled, ...). Children are the visible text.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  type Props = Omit<HTMLButtonAttributes, 'class' | 'children'> & {
    variant?: 'secondary' | 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'link';
    size?: 'sm' | 'md' | 'lg';
    icon?: IconName;
    iconOnly?: boolean;
    label?: string;
    loading?: boolean;
    block?: boolean;
    href?: string;
    target?: string;
    class?: string;
    children?: Snippet;
  };

  let {
    variant = 'secondary',
    size = 'md',
    icon,
    iconOnly = false,
    label,
    loading = false,
    block = false,
    href,
    target,
    class: extra = '',
    type = 'button',
    disabled = false,
    children,
    ...rest
  }: Props = $props();

  const classes = $derived(
    [
      variant === 'danger-solid' ? 'primary danger' : variant === 'secondary' ? '' : variant,
      size === 'md' ? '' : size,
      iconOnly ? 'icon' : '',
      block ? 'block' : '',
      loading ? 'loading' : '',
      extra,
    ]
      .filter(Boolean)
      .join(' '),
  );
  const iconSize = $derived(size === 'lg' ? 18 : 16);
</script>

{#if href}
  <a
    {href}
    {target}
    rel={target === '_blank' ? 'noopener noreferrer' : undefined}
    class="btn {classes}"
    aria-label={label}
    aria-disabled={disabled || loading ? 'true' : undefined}
  >
    {#if icon && !loading}<Icon name={icon} size={iconSize} />{/if}
    {@render children?.()}
  </a>
{:else}
  <button
    {...rest}
    {type}
    class={classes}
    aria-label={label}
    aria-busy={loading ? 'true' : undefined}
    disabled={disabled || loading}
  >
    {#if icon && !loading}<Icon name={icon} size={iconSize} />{/if}
    {@render children?.()}
  </button>
{/if}
