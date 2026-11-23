import { getContext, setContext } from 'svelte';

/**
 * Whether the app compares its repository with the store (app listing settings, default off). The listing page sets it once from the drift
 * answer (`drift.compare.repo`); the field and drawer components read it, so nothing about the repository (a third column, "Stage from repo",
 * "only one side has a value") shows when the comparison is off. Without a provider it reads as on.
 */
const KEY = Symbol('kiln.listing.compare');

export type CompareState = { readonly repo: boolean; readonly media: boolean };

export function provideCompare(read: () => CompareState): void {
  setContext(KEY, read);
}

export function useCompare(): () => CompareState {
  return getContext<(() => CompareState) | undefined>(KEY) ?? (() => ({ repo: true, media: true }));
}
