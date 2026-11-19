import type { AiTaskId } from '@mrm/core';
import { keywordIdeasTask } from './ai-task-keywords.ts';
import { listingImproveTask } from './ai-task-listing.ts';
import { reviewReplyTask } from './ai-task-reply.ts';
import type { AiTask, PlannedTask } from './ai-task-types.ts';

/**
 * The registry of AI tasks (docs/adr/0016-ai-foundation.md). A task not listed here cannot be run: default deny.
 * Three are built; three are registered with their disclosure plan so the list a person sees is complete, and answer
 * `409 task_not_available` until their input builders exist. Adding a task is: a file like ai-task-keywords.ts, one line
 * here, one id in core/src/ai.ts, and a test that its schema is strict and its post-processor flags what it must.
 */

const planned = (task: Omit<PlannedTask, 'status' | 'scope'> & { scope?: PlannedTask['scope'] }): PlannedTask => ({
  status: 'planned',
  scope: [],
  ...task,
});

export const releaseNotesTask: PlannedTask = planned({
  id: 'release_notes',
  version: 1,
  label: 'Draft release notes',
  description: 'Would turn the commit and change titles of a release into "What is new" text per language. Not built yet.',
  disclosure: {
    sends: ['Planned: the titles of the changes in the release you choose, and the language.'],
    neverSends: ['Planned: credentials, review text, people, code or diffs.'],
  },
});

export const listingTranslateTask: PlannedTask = planned({
  id: 'listing_translate',
  version: 1,
  label: 'Translate the listing',
  description: 'Would translate listing text into another language within the store limits, as staged changes. Not built yet. Text translation by a translation service already exists.',
  disclosure: {
    sends: ['Planned: the listing text of the source language you choose and the target language.'],
    neverSends: ['Planned: credentials, review text, people.'],
  },
});

export const rankDropExplainTask: PlannedTask = planned({
  id: 'rank_drop_explain',
  version: 1,
  label: 'Explain a rank drop',
  description: 'Would suggest likely reasons for a keyword rank drop from the rank history, listing changes and competitors. Not built yet.',
  disclosure: {
    sends: ['Planned: the rank history of one keyword, the dates of listing changes, and competitor names.'],
    neverSends: ['Planned: credentials, review text, people.'],
  },
});

export const aiTasks: readonly AiTask[] = [
  keywordIdeasTask,
  listingImproveTask,
  reviewReplyTask,
  releaseNotesTask,
  listingTranslateTask,
  rankDropExplainTask,
];

export const findAiTask = (id: string): AiTask | undefined => aiTasks.find((t) => t.id === id);
export const isRegisteredTaskId = (id: string): id is AiTaskId => aiTasks.some((t) => t.id === id);
