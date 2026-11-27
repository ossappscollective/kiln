/**
 * Per-key instances that live as long as the screen that asked for them (`const dataFor = keyedInstances(() => new PlatformData())`).
 *
 * A component never keeps its own `new Map` cache (component guard R2): a keyed holder is named here, so a screen that needs "one reader
 * per app, shared by the figures and every section" says so in one line and the lifetime is the caller's.
 */
export function keyedInstances<V>(make: (key: string) => V): (key: string) => V {
  const held = new Map<string, V>();
  return (key) => {
    let value = held.get(key);
    if (value === undefined) {
      value = make(key);
      held.set(key, value);
    }
    return value;
  };
}
