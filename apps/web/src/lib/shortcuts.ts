/**
 * Keyboard shortcuts of the shell, in one registry, and the small state machine that reads them.
 * Pure: no `window`, no `document`. The shell feeds key presses in (`stepShortcut`) and acts on what
 * comes out.
 *
 * Three families, none of which can clash with the single keys of the reviews inbox (j k t r / and
 * the arrows), because those screens ignore a key while a modifier is held, and a chord only starts
 * with `g`, which no screen uses:
 * - Cmd or Ctrl + K opens the app switcher.
 * - Cmd or Ctrl + 1 to 9 jumps to the first nine apps of the switcher.
 * - `g`, then one letter, goes to a section: inside an app (`g d` dashboard, `g l` listing, ...) or
 *   in the workspace (`g a` all apps, `g v` reviews inbox, ...).
 * Nothing fires while a field has the focus (a modifier combination may), while a dialog is open or
 * on a held key.
 */

export const CHORD_LEADER = 'g';
/** How long the letter after `g` is waited for. */
export const CHORD_TIMEOUT_MS = 1500;

export type ShortcutContext = 'app' | 'workspace';
export type SectionChord = { key: string; target: string; label: string };

/** Inside an app: the target is an app section id (lib/app-scope.ts). */
export const appChords: readonly SectionChord[] = [
  { key: 'd', target: 'dashboard', label: 'Overview' },
  { key: 'r', target: 'releases', label: 'Releases' },
  { key: 'l', target: 'listing', label: 'Store listing' },
  { key: 'v', target: 'reviews', label: 'Reviews' },
  { key: 'i', target: 'insights', label: 'Insights' },
  { key: 'b', target: 'builds', label: 'Builds' },
  // The pages that now sit inside another page keep their keys: the address redirects (lib/app-nav.ts).
  { key: 'p', target: 'pending', label: 'Pending changes' },
  { key: 'a', target: 'assets', label: 'Graphics (in Store listing)' },
  { key: 'o', target: 'aso', label: 'ASO (in Insights)' },
  { key: 'n', target: 'analytics', label: 'Analytics (in Insights)' },
  { key: 'w', target: 'workflows', label: 'Workflows (in Builds)' },
  { key: 't', target: 'test-builds', label: 'Test builds (in Builds)' },
  { key: 's', target: 'settings', label: 'App settings' },
];

/** In the workspace: the target is a view id (lib/views.ts). */
export const workspaceChords: readonly SectionChord[] = [
  { key: 'a', target: 'portfolio', label: 'All apps' },
  { key: 'v', target: 'reviews', label: 'Reviews inbox' },
  { key: 'o', target: 'aso', label: 'ASO' },
  { key: 'r', target: 'repositories', label: 'Repositories' },
  { key: 'w', target: 'workflows', label: 'Workflows' },
  { key: 'c', target: 'credentials', label: 'Credentials' },
  { key: 'm', target: 'members', label: 'Members' },
  { key: 't', target: 'tokens', label: 'API tokens' },
  { key: 'h', target: 'webhooks', label: 'Webhooks' },
  { key: 's', target: 'settings', label: 'Settings' },
  { key: 'u', target: 'audit', label: 'Audit log' },
];

export const chordsFor = (context: ShortcutContext): readonly SectionChord[] => (context === 'app' ? appChords : workspaceChords);

/** The two keys to press for a section ("g d"), or null when it has none. */
export function chordHint(context: ShortcutContext, target: string): string | null {
  const found = chordsFor(context).find((c) => c.target === target);
  return found ? `${CHORD_LEADER} ${found.key}` : null;
}

/** The single keys other screens own (the reviews inbox). Listed so the registry can say they are taken. */
export const reservedKeys: readonly string[] = ['j', 'k', 't', 'r', '/', 'ArrowDown', 'ArrowUp', 'Home', 'End'];

export type ShortcutDef = { keys: string; label: string; group: 'Anywhere' | 'Go to' | 'Reviews' };

/** Everything the shortcuts help lists, from the same tables the keys are read from. */
export function shortcutRegistry(context: ShortcutContext, mod = 'Ctrl'): ShortcutDef[] {
  return [
    { keys: `${mod} K`, label: 'Search apps and open one', group: 'Anywhere' },
    { keys: `${mod} 1 to 9`, label: 'Open the first nine apps', group: 'Anywhere' },
    ...chordsFor(context).map((c): ShortcutDef => ({ keys: `${CHORD_LEADER} ${c.key}`, label: c.label, group: 'Go to' })),
    { keys: 'j k', label: 'Next and previous review', group: 'Reviews' },
    { keys: 't', label: 'Mark the review triaged', group: 'Reviews' },
    { keys: 'r', label: 'Reply to the review', group: 'Reviews' },
    { keys: '/', label: 'Search the reviews', group: 'Reviews' },
  ];
}

export type KeyInput = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  /** A text field (or a select, or editable text) has the focus. */
  typing: boolean;
  /** A modal dialog is open. */
  dialogOpen?: boolean;
};

export type ChordState = { pendingAt: number | null };
export const idleChord: ChordState = { pendingAt: null };

export type ShortcutAction =
  | { type: 'open-switcher' }
  | { type: 'jump-app'; index: number }
  | { type: 'go'; target: string }
  | { type: 'pending' }
  | { type: 'cancel' };

export type ShortcutStep = {
  action: ShortcutAction | null;
  state: ChordState;
  /** The caller should `preventDefault` (and stop the key reaching other handlers). */
  consume: boolean;
};

const none = (state: ChordState = idleChord): ShortcutStep => ({ action: null, state, consume: false });

/** Whether a focus target is a field a person types into. Structural, so it needs no DOM in tests. */
export function isTypingTarget(target: { tagName?: string; isContentEditable?: boolean } | null | undefined): boolean {
  if (!target || typeof target.tagName !== 'string') return false;
  const tag = target.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/**
 * One key press. `state` is what the last call returned (`idleChord` at the start), `now` epoch ms.
 * Returns the action to take, the new state and whether the key is consumed.
 */
export function stepShortcut(state: ChordState, input: KeyInput, now: number, context: ShortcutContext): ShortcutStep {
  if (input.repeat) return none(state);
  const mod = input.metaKey === true || input.ctrlKey === true;
  const key = input.key;

  if (mod) {
    if (input.altKey || input.shiftKey || input.dialogOpen) return none();
    if (key === 'k' || key === 'K') return { action: { type: 'open-switcher' }, state: idleChord, consume: true };
    if (/^[1-9]$/.test(key)) return { action: { type: 'jump-app', index: Number(key) - 1 }, state: idleChord, consume: true };
    return none();
  }

  if (input.typing || input.dialogOpen || input.altKey) return none();

  const pending = state.pendingAt !== null && now - state.pendingAt <= CHORD_TIMEOUT_MS;
  if (pending) {
    if (key === 'Escape') return { action: { type: 'cancel' }, state: idleChord, consume: false };
    if (key === 'Shift') return none(state);
    const found = input.shiftKey ? undefined : chordsFor(context).find((c) => c.key === key);
    if (found) return { action: { type: 'go', target: found.target }, state: idleChord, consume: true };
    // Not a chord: the key goes on to whoever owns it.
    return { action: { type: 'cancel' }, state: idleChord, consume: false };
  }

  if (key === CHORD_LEADER && !input.shiftKey) return { action: { type: 'pending' }, state: { pendingAt: now }, consume: false };
  return none();
}
