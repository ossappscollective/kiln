import type { AiAcceptedRef, AiSuggestionView } from '@mrm/core';
import type { AiAcceptBody, AiConfig, AiReviewTagView, AiRunBody, AiTaskView, AiTasksResponse, AiUsageWarning } from './ai.ts';
import { isOpen } from './ai.ts';
import type { Api } from './api.ts';

/**
 * What the screens know about AI assistance (docs/api/ai.md): the configuration and usage of the workspace, the list of tasks with what each
 * sends, and the suggestions of the apps on screen. It holds what the server last said and nothing else (no prompt, no key, no provider
 * text: the API never returns them). A run adds its suggestion here; accepting or dismissing updates it, so every tray and drawer that shows
 * the same suggestion agrees. Nothing in this file pushes, submits, publishes, releases or sends: it only calls the AI routes.
 */
let configs = $state<Record<string, AiConfig | undefined>>({});
let configFailed = $state<Record<string, boolean | undefined>>({});
let taskLists = $state<Record<string, AiTasksResponse | undefined>>({});
let suggestions = $state<Record<string, AiSuggestionView[] | undefined>>({});
/** What a person accepted in this page load, so the tray can say what happened until they close the note. */
let settled = $state<Record<string, AiAcceptedRef | undefined>>({});
/** Bumped per app when a run added a suggestion: a tray opens itself on it. */
let fresh = $state<Record<string, number | undefined>>({});

/** The warning the last run answered with (near a monthly limit), per workspace, until a screen has shown it. */
let warnings = $state<Record<string, AiUsageWarning | undefined>>({});
/** The tags the assistant gave reviews, by review id (advisory labels). Reads our own database. */
let tags = $state<Record<string, AiReviewTagView | undefined>>({});
/** Review ids a read was made for (so a review without tags is not asked again and again). */
const tagsAsked: Record<string, boolean | undefined> = {};

const configLoading: Record<string, Promise<AiConfig | null> | undefined> = {};
const tasksLoading: Record<string, Promise<AiTasksResponse | null> | undefined> = {};
const suggestionLoading: Record<string, Promise<string> | undefined> = {};

function put(appId: string, next: AiSuggestionView): void {
  const list = suggestions[appId] ?? [];
  const at = list.findIndex((s) => s.id === next.id);
  suggestions[appId] = at < 0 ? [next, ...list] : list.map((s) => (s.id === next.id ? next : s));
}

export const aiStore = {
  /** The configuration of a workspace, or null before it was read (or when this role cannot read it). */
  config(workspaceId: string): AiConfig | null {
    return configs[workspaceId] ?? null;
  },
  configFailed(workspaceId: string): boolean {
    return configFailed[workspaceId] === true;
  },
  /** Reads the configuration once per workspace (`force` reads again). Never throws; a failure leaves it unknown and the controls hidden. */
  loadConfig(api: Api, workspaceId: string, force = false): Promise<AiConfig | null> {
    const known = configs[workspaceId];
    if (!force && known !== undefined) return Promise.resolve(known);
    const running = configLoading[workspaceId];
    if (running !== undefined) return running;
    const job = api
      .aiConfig(workspaceId)
      .then((c) => {
        configs[workspaceId] = c;
        configFailed[workspaceId] = false;
        return c;
      })
      .catch(() => {
        configFailed[workspaceId] = true;
        return null;
      })
      .then((c) => {
        configLoading[workspaceId] = undefined;
        return c;
      });
    configLoading[workspaceId] = job;
    return job;
  },
  /** The settings screen saved: what it got back is the newest configuration. */
  setConfig(workspaceId: string, config: AiConfig): void {
    configs[workspaceId] = config;
    configFailed[workspaceId] = false;
    taskLists[workspaceId] = undefined;
  },

  tasks(workspaceId: string): AiTasksResponse | null {
    return taskLists[workspaceId] ?? null;
  },
  task(workspaceId: string, taskId: string): AiTaskView | null {
    return taskLists[workspaceId]?.tasks.find((t) => t.id === taskId) ?? null;
  },
  /** The tasks and what each sends. Null when they could not be read (then nothing runs: the disclosure cannot be shown). */
  loadTasks(api: Api, workspaceId: string, force = false): Promise<AiTasksResponse | null> {
    const known = taskLists[workspaceId];
    if (!force && known !== undefined) return Promise.resolve(known);
    const running = tasksLoading[workspaceId];
    if (running !== undefined) return running;
    const job = api
      .aiTasks(workspaceId)
      .then((t) => {
        taskLists[workspaceId] = t;
        return t;
      })
      .catch(() => null)
      .then((t) => {
        tasksLoading[workspaceId] = undefined;
        return t;
      });
    tasksLoading[workspaceId] = job;
    return job;
  },

  /** Every suggestion of an app that was read or made here, newest first; null before the first read. */
  all(appId: string): AiSuggestionView[] | null {
    return suggestions[appId] ?? null;
  },
  byId(appId: string, id: string): AiSuggestionView | null {
    return suggestions[appId]?.find((s) => s.id === id) ?? null;
  },
  /** What the tray lists: the open suggestions, and the ones accepted in this page load whose note has not been closed. */
  shown(appId: string): AiSuggestionView[] {
    return (suggestions[appId] ?? []).filter((s) => isOpen(s) || settled[s.id] !== undefined);
  },
  openCount(appId: string): number {
    return (suggestions[appId] ?? []).filter(isOpen).length;
  },
  settled(id: string): AiAcceptedRef | null {
    return settled[id] ?? null;
  },
  closeNote(id: string): void {
    settled[id] = undefined;
  },
  freshCount(appId: string): number {
    return fresh[appId] ?? 0;
  },

  /** Reads the open suggestions of an app. Returns '' when it worked, else a sentence. */
  loadSuggestions(api: Api, workspaceId: string, appId: string, force = false): Promise<string> {
    if (!force && suggestions[appId] !== undefined) return Promise.resolve('');
    const running = suggestionLoading[appId];
    if (running !== undefined) return running;
    const job = api
      .appAiSuggestions(workspaceId, appId, { status: 'proposed', limit: 20 })
      .then((out) => {
        const mine = suggestions[appId] ?? [];
        // A suggestion made or decided here while the read was out is newer than the read: keep it.
        const kept = mine.filter((s) => !out.suggestions.some((o) => o.id === s.id));
        suggestions[appId] = [...out.suggestions.map((o) => mine.find((m) => m.id === o.id) ?? o), ...kept].sort((a, b) => b.createdAt - a.createdAt);
        return '';
      })
      .catch(() => 'Could not read the AI suggestions.')
      .then((message) => {
        suggestionLoading[appId] = undefined;
        return message;
      });
    suggestionLoading[appId] = job;
    return job;
  },

  /**
   * Runs a task for an app. It stores the suggestion it made and returns it; an error (an `ApiError`) is thrown for the screen to turn
   * into a sentence. The usage meter is read again afterwards, quietly.
   */
  async run(api: Api, workspaceId: string, taskId: string, body: AiRunBody): Promise<AiSuggestionView> {
    try {
      const out = await api.runAiTask(workspaceId, taskId, body);
      warnings[workspaceId] = out.warning ?? undefined;
      put(body.appId, out.suggestion);
      fresh[body.appId] = (fresh[body.appId] ?? 0) + 1;
      return out.suggestion;
    } finally {
      void aiStore.loadConfig(api, workspaceId, true);
    }
  },

  /** The warning of the last run for a workspace, once: null when there is none or it was already taken. */
  takeWarning(workspaceId: string): AiUsageWarning | null {
    const w = warnings[workspaceId] ?? null;
    if (w !== null) warnings[workspaceId] = undefined;
    return w;
  },

  /** The tags of one review, or null when it has none (yet). */
  tagFor(reviewId: string): AiReviewTagView | null {
    return tags[reviewId] ?? null;
  },
  /** Reads the tags of the given reviews that were not asked for yet (`force`: all of them again). Never throws: tags are a quiet extra. */
  async loadTags(api: Api, workspaceId: string, appId: string, reviewIds: readonly string[], force = false): Promise<void> {
    const want = reviewIds.filter((id) => force || tagsAsked[id] !== true);
    for (let at = 0; at < want.length; at += 100) {
      const chunk = want.slice(at, at + 100);
      try {
        const out = await api.reviewAiTags(workspaceId, appId, chunk);
        for (const id of chunk) tagsAsked[id] = true;
        for (const t of out.tags) tags[t.reviewId] = t;
      } catch {
        // Quiet: a review without tags simply shows none.
      }
    }
  },

  /** Accepts the chosen parts. The server closes the suggestion on the first accept. Throws an `ApiError` when it is refused. */
  async accept(api: Api, workspaceId: string, suggestion: AiSuggestionView, body: AiAcceptBody): Promise<AiAcceptedRef> {
    const out = await api.acceptAiSuggestion(workspaceId, suggestion.id, body);
    put(suggestion.appId, out.suggestion);
    settled[suggestion.id] = out.result;
    return out.result;
  },

  async dismiss(api: Api, workspaceId: string, suggestion: AiSuggestionView): Promise<void> {
    const out = await api.dismissAiSuggestion(workspaceId, suggestion.id);
    put(suggestion.appId, out.suggestion);
  },

  /** Forgets everything (sign out, tests). */
  forget(): void {
    configs = {};
    configFailed = {};
    taskLists = {};
    suggestions = {};
    settled = {};
    fresh = {};
    warnings = {};
    tags = {};
    for (const k of Object.keys(tagsAsked)) tagsAsked[k] = undefined;
  },
};
