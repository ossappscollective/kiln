/**
 * The facade of the AI engine's configuration: the one file the release surfaces import the AI store through.
 *
 * The component guard (R7) allows a component to reach a state store only through `lib/app-state/`. The notes step asks the store
 * whether the engine is configured and allowed (`aiEngine`) to decide whether to offer a suggestion; it does not draw any release
 * fact from it, so the model has nothing to hand over here.
 */
export { aiStore } from '../ai/store.svelte.ts';
