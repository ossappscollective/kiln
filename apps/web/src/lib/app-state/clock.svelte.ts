/**
 * The clock of a screen: the "now" a screen draws ages and waits with ("updated 3 min ago", "waiting for 12 s").
 *
 * A component never keeps its own `Date.now()` / `setInterval` (component guard R2): freshness belongs to the model, and a screen that
 * needs the time to move asks for it here. One helper, one rule for when it ticks, and the timer is cleaned up with the component.
 *
 *     const clock = useNow({ everyMs: 30_000 });      // ticks while the component lives
 *     const now = $derived(clock.value);
 *     clock.touch();                                  // after a read: the age is measured from this moment
 *
 * `while` makes the tick conditional (a publish that runs): the timer exists only while it answers true, and `value` is read again when it
 * starts; `visibleOnly` skips the ticks of a hidden tab. Call it while a component initialises (it registers an effect).
 */
import { untrack } from 'svelte';

export type Clock = {
  /** Milliseconds since the epoch, as of the last tick or `touch`. */
  readonly value: number;
  /** Read the time now (after a load, so the age starts from here); returns it. */
  touch(): number;
};

export function useNow(options: { everyMs?: number; while?: () => boolean; visibleOnly?: boolean } = {}): Clock {
  let value = $state(Date.now());
  const touch = (): number => (value = Date.now());
  const { everyMs, while: active, visibleOnly } = options;
  if (everyMs !== undefined) {
    $effect(() => {
      if (active !== undefined && !active()) return;
      untrack(touch);
      const timer = setInterval(() => {
        if (visibleOnly && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
        touch();
        if (active !== undefined && !untrack(active)) clearInterval(timer);
      }, everyMs);
      return () => clearInterval(timer);
    });
  }
  return {
    get value() {
      return value;
    },
    touch,
  };
}

/**
 * A poll of a screen: runs `tick` every `everyMs` while `while` answers true (default: always), cleaned up with the component. A
 * component never keeps its own `setInterval` (component guard R2); the poll and its stop condition live here.
 *
 *     usePoll(() => void load(), 60_000, { while: () => status?.active === true });
 */
export function usePoll(tick: () => void, everyMs: number, options: { while?: () => boolean } = {}): void {
  const { while: active } = options;
  $effect(() => {
    if (active !== undefined && !active()) return;
    const timer = setInterval(tick, everyMs);
    return () => clearInterval(timer);
  });
}

/**
 * The instant of an event (a click, a keystroke, a finished test): read once, not drawn. A component takes the timestamp of an event
 * from here, so no component calls `Date.now()` itself (component guard R2). For what a screen DRAWS ("3 min ago"), use `useNow`.
 */
export function readNow(): number {
  return Date.now();
}
