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
 * starts. Call it while a component initialises (it registers an effect).
 */
export type Clock = {
  /** Milliseconds since the epoch, as of the last tick or `touch`. */
  readonly value: number;
  /** Read the time now (after a load, so the age starts from here); returns it. */
  touch(): number;
};

export function useNow(options: { everyMs?: number; while?: () => boolean } = {}): Clock {
  let value = $state(Date.now());
  const touch = (): number => (value = Date.now());
  const { everyMs, while: active } = options;
  if (everyMs !== undefined) {
    $effect(() => {
      if (active !== undefined && !active()) return;
      touch();
      const timer = setInterval(touch, everyMs);
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
