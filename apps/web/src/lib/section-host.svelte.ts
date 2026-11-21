import { getContext, setContext } from 'svelte';
import {
  browserStorage,
  readSectionOpen,
  type SectionScope,
  type StorageLike,
  writeSectionOpen,
  writeSectionsOpen,
} from './section-state.ts';

/**
 * The page-wide side of the collapsible sections: the shell makes one host (scope = workspace, person and page, read when a section is
 * drawn), every `Section` registers with it, and `SectionsToggle` collapses or expands all of them at once. Without a host (a section
 * used alone) a section just starts at its default and is not remembered.
 */
export type SectionHost = {
  scope(): SectionScope;
  /** How many sections the page draws right now, and whether any is open (the toggle all button). */
  readonly count: number;
  readonly anyOpen: boolean;
  read(key: string, fallback: boolean): boolean;
  write(key: string, open: boolean): void;
  /** A section announces itself; the return is how it leaves. `set` is how the host opens or closes it. */
  register(id: string, key: string, open: boolean, set: (open: boolean) => void): () => void;
  update(id: string, open: boolean): void;
  setAll(open: boolean): void;
};

const HOST = Symbol('kiln.section-host');

export function createSectionHost(
  scope: () => SectionScope,
  storage: StorageLike | null = browserStorage(),
): SectionHost {
  let entries = $state<Record<string, { key: string; open: boolean }>>({});
  const setters = new Map<string, (open: boolean) => void>();
  return {
    scope,
    get count() {
      return Object.keys(entries).length;
    },
    get anyOpen() {
      return Object.values(entries).some((e) => e.open);
    },
    read: (key, fallback) => readSectionOpen(storage, scope(), key, fallback),
    write: (key, open) => void writeSectionOpen(storage, scope(), key, open),
    register(id, key, open, set) {
      entries[id] = { key, open };
      setters.set(id, set);
      return () => {
        delete entries[id];
        setters.delete(id);
      };
    },
    update(id, open) {
      const e = entries[id];
      if (e && e.open !== open) e.open = open;
    },
    setAll(open) {
      const changes: Record<string, boolean> = {};
      for (const [id, e] of Object.entries(entries)) {
        changes[e.key] = open;
        setters.get(id)?.(open);
      }
      writeSectionsOpen(storage, scope(), changes);
    },
  };
}

export const provideSectionHost = (host: SectionHost): void => void setContext(HOST, host);
export const sectionHost = (): SectionHost | null =>
  getContext<SectionHost | undefined>(HOST) ?? null;
