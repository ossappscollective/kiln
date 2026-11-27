/**
 * The facade of the alerts store: the one file the alert screens (bell, inbox, settings, shell) import it through (component guard R7).
 * The alert list and its unread count are DRAWN from the store; the model owns the facts the alerts are about.
 */
export { alertStore } from '../alerts/store.svelte.ts';
