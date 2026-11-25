<!--
  Button: the global button styles as a component.
  Props: variant = 'secondary' | 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'link',
  size = 'md' | 'sm' | 'lg', icon? (leading icon name), iconOnly (square button; give `label`),
  label? (accessible name for icon-only buttons), loading (shows a spinner, blocks clicks),
  block (full width), href? (renders a link styled as a button), plus any button attribute
  (type defaults to 'button', onclick, disabled, ...). Children are the visible text. A link keeps its `onclick` too (a link with an
  onclick is how a button that also navigates closes a dialog or queues what the next screen opens).
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons.ts';

  type Props = Omit<HTMLButtonAttributes, 'class' | 'children'> & {
    variant?: 'secondary' | 'primary' | 'danger' | 'danger-solid' | 'ghost' | 'link' | undefined;
    size?: 'sm' | 'md' | 'lg' | undefined;
    icon?: IconName | undefined;
    iconOnly?: boolean | undefined;
    label?: string | undefined;
    loading?: boolean | undefined;
    block?: boolean | undefined;
    href?: string | undefined;
    target?: string | undefined;
    class?: string | undefined;
    children?: Snippet | undefined;
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
    onclick,
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
    onclick={onclick as ((event: MouseEvent) => void) | undefined}
  >
    {#if icon && !loading}<Icon name={icon} size={iconSize} />{/if}
    {@render children?.()}
  </a>
{:else}
  <button
    {...rest}
    {type}
    {onclick}
    class={classes}
    aria-label={label}
    aria-busy={loading ? 'true' : undefined}
    disabled={disabled || loading}
  >
    {#if icon && !loading}<Icon name={icon} size={iconSize} />{/if}
    {@render children?.()}
  </button>
{/if}
