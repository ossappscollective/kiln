/**
 * A tiny toast store. Call `toast.success('Saved')` from anywhere; <ToastHost /> (mounted once in
 * App.svelte) shows them. Errors stay until dismissed; the rest leave after a few seconds.
 */

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

/** A link or button inside a toast, such as "Review the change set". `onclick` runs before a link is followed. */
export type ToastAction = { label: string; href?: string; onclick?: () => void };

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  title?: string;
  action?: ToastAction;
};

export type ToastOptions = {
  title?: string;
  /** Milliseconds before it leaves. 0 keeps it until dismissed. */
  timeout?: number;
  action?: ToastAction;
};

const MAX_VISIBLE = 4;
const DEFAULT_TIMEOUT: Record<ToastKind, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: 0,
};

let items = $state<Toast[]>([]);
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
  items = items.filter((t) => t.id !== id);
}

function push(kind: ToastKind, message: string, options: ToastOptions = {}): number {
  const id = nextId++;
  items = [
    ...items,
    {
      id,
      kind,
      message,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.action ? { action: options.action } : {}),
    },
  ].slice(-MAX_VISIBLE);
  const timeout = options.timeout ?? DEFAULT_TIMEOUT[kind];
  if (timeout > 0)
    timers.set(
      id,
      setTimeout(() => dismiss(id), timeout),
    );
  return id;
}

export const toast = {
  info: (message: string, options?: ToastOptions) => push('info', message, options),
  success: (message: string, options?: ToastOptions) => push('success', message, options),
  warning: (message: string, options?: ToastOptions) => push('warning', message, options),
  error: (message: string, options?: ToastOptions) => push('error', message, options),
  dismiss,
  clear: () => {
    for (const id of [...timers.keys()]) dismiss(id);
    items = [];
  },
};

/** The toasts on screen, oldest first. Read-only; use `toast` to change them. */
export function visibleToasts(): readonly Toast[] {
  return items;
}
