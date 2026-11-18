import { type AppAddress, type PlatformScope, parseAppAddress, withScope } from './app-scope.ts';

/**
 * The page address as reactive state, and the platform scope of the open app kept in it. The
 * address is the source of truth (`#/portfolio/<id>/<section>?platform=ios`); every app tab reads
 * the scope from here, so a change in one place shows in all of them and survives a reload.
 */

let current = $state(typeof location === 'undefined' ? '' : location.hash);

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = location.hash;
  });
}

export const address = {
  get hash(): string {
    return current;
  },
  /** The open app, section and scope; null when the address is not an app. */
  get app(): AppAddress | null {
    return parseAppAddress(current);
  },
  /** What the address asks for. The screens resolve it against the platforms the app has. */
  get platform(): PlatformScope | null {
    return parseAppAddress(current)?.platform ?? null;
  },
};

/**
 * Changes the address without a history entry. Screens that read the hash themselves are told
 * with a `hashchange`, as if the person had followed a link.
 */
export function replaceHash(next: string): void {
  if (next === location.hash) return;
  history.replaceState(null, '', next);
  current = next;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

/** Sets the platform scope of the open app (null removes it from the address). */
export function setPlatformScope(scope: PlatformScope | null): void {
  replaceHash(withScope(location.hash, scope));
}

/** The name of the open app, set by the app screen so the shell can show it in the breadcrumb. */
let openName = $state('');
export const appContext = {
  get name(): string {
    return openName;
  },
  set name(value: string) {
    openName = value;
  },
};
