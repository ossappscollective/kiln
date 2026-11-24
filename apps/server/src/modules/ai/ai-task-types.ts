import type { JsonSchema } from '@kiln/connectors';
import type { AiAppContext, AiProposal, AiProposalKind, AiTaskId } from '@kiln/core';
import type { Database, Sql } from '@kiln/db';
import type { ManagedApp } from '../../services/apps.ts';
import { type AiFailure, aiFail } from './ai-config.ts';
import type { ReviewSendPolicy } from './ai-task-data.ts';

/**
 * What an AI task is (docs/adr/0016-ai-foundation.md). A task is DATA plus three pure-ish functions:
 *
 * - `prepare` builds the input from stored data. Only the allow-listed fields named in `disclosure.sends` go into it, and
 *   the disclosure is shown to the person BEFORE the first run. It reads the database only; it never contacts a store.
 * - `system` is the instruction text. It never contains data of the workspace.
 * - `propose` turns the model's schema-valid output into a PROPOSAL: every item is cleaned, checked against what the store
 *   allows, and FLAGGED when it was changed or cannot be accepted. Nothing in a task can act: there is no tool, no store
 *   call, no write. Accepting is a separate step, done by a person, through an existing mechanism (services/ai.ts).
 *
 * The output of the model is untrusted data, exactly like the review and competitor text that went in. It is validated
 * against the task's JSON schema by the provider layer, post-processed here, stored as a proposal and shown to a person.
 */

export type TaskContext = {
  db: Database;
  now: () => number;
  workspaceId: string;
  app: ManagedApp;
  /** What the person told the assistant about this app (docs/adr/0024-ai-features.md). Empty when nothing was written. */
  context: AiAppContext;
  /** What may leave the server about reviews of this app (docs/adr/0065). Absent: text only, redacted. */
  reviewPolicy?: ReviewSendPolicy;
};

/** What a task's `persist` step knows about the run it belongs to. */
export type PersistInfo = {
  workspaceId: string;
  appId: string;
  provider: string;
  model: string;
  at: number;
};

export type PreparedRun = {
  /** The structured data sent: only what the disclosure lists. */
  input: unknown;
  /** Ids and options of the run, stored with the suggestion. Never text. */
  scope: Record<string, unknown>;
  /** Replaces the task's schema for this run (the field names a run may answer for). */
  schema?: JsonSchema;
  /** Server-side facts for `propose` (limits, tracked terms). Not sent and not stored. */
  facts: unknown;
};

export type ScopeField = {
  name: string;
  required: boolean;
  description: string;
  /** The allowed values, for a choice. */
  values?: string[];
};

/** What leaves the server, as sentences a person reads before using a task. */
export type TaskDisclosure = { sends: string[]; neverSends: string[] };

type TaskBase = {
  id: AiTaskId;
  /** Raised whenever the input, the prompt, the schema or the post-processing changes in a way that matters. Stored with every suggestion. */
  version: number;
  label: string;
  description: string;
  disclosure: TaskDisclosure;
  scope: ScopeField[];
};

export type ReadyTask = TaskBase & {
  status: 'ready';
  proposalKind: AiProposalKind;
  system: string;
  schema: JsonSchema;
  schemaName: string;
  /** The most the model may write for this task; the workspace's own cap can lower it. */
  maxOutputTokens: number;
  prepare(ctx: TaskContext, scope: Record<string, unknown>): Promise<PreparedRun | AiFailure>;
  propose(output: unknown, run: PreparedRun): AiProposal;
  /**
   * `false`: the app context is NOT added to this task's input. For a task whose result is cached (review tags): the cache must not
   * depend on text that a person can edit. Default: the context is added (only the filled in parts), as `appContext`.
   */
  useContext?: boolean;
  /**
   * Days a stored result of this task is reused when the data of a run is the same (`scope.key` of the run equals the one stored).
   * A run with `refresh: true` ignores it. Nothing is sent and nothing is spent on a reuse.
   */
  cacheDays?: number;
  /**
   * Runs in the same transaction that stores the suggestion, for a task whose result is also kept somewhere other than the
   * suggestion (the review tags cache). It writes the task's OWN tables only.
   */
  persist?(sql: Sql, info: PersistInfo, proposal: AiProposal, run: PreparedRun): Promise<void>;
};

/** Registered, not built yet: listed with its disclosure plan, answers 409 `task_not_available` when run. */
export type PlannedTask = TaskBase & { status: 'planned' };

export type AiTask = ReadyTask | PlannedTask;

// ---------------------------------------------------------------------------------------------
// Helpers shared by the tasks

/** Refuses a scope with a field the task does not have, or a required one missing. */
export function checkScope(
  task: Pick<TaskBase, 'scope'>,
  scope: Record<string, unknown>,
): AiFailure | undefined {
  const names = new Set(task.scope.map((f) => f.name));
  const issues: { path: string; message: string }[] = [];
  for (const key of Object.keys(scope))
    if (!names.has(key)) issues.push({ path: key, message: 'Not an option of this task.' });
  for (const field of task.scope) {
    if (
      field.required &&
      (scope[field.name] === undefined || scope[field.name] === null || scope[field.name] === '')
    ) {
      issues.push({ path: field.name, message: 'Required.' });
    }
    if (
      field.values &&
      scope[field.name] !== undefined &&
      !field.values.includes(String(scope[field.name]))
    ) {
      issues.push({ path: field.name, message: `Use one of ${field.values.join(', ')}.` });
    }
  }
  return issues.length > 0
    ? aiFail(400, 'invalid_request', 'The options of this task are not valid.', { issues })
    : undefined;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
const CONTROL =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Text from a model (or from a person) made safe to store and show: control characters and bidi overrides are
 * removed (`changed` says so), line breaks are `\n`, and a single line has its white space collapsed.
 */
export function cleanText(
  value: string,
  options: { multiline?: boolean } = {},
): { text: string; changed: boolean } {
  const withoutControl = value.replace(/\r\n?/g, '\n').replace(CONTROL, '');
  const changed = withoutControl !== value.replace(/\r\n?/g, '\n');
  const text = options.multiline
    ? withoutControl.replace(/[ \t]+\n/g, '\n').trim()
    : withoutControl.replace(/\s+/g, ' ').trim();
  return { text, changed };
}

/** At most `max` code points. */
export function clip(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : points.slice(0, max).join('');
}

/** One-line free text from a person, for the optional goal of a run: cleaned and cut. */
export function cleanGoal(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = clip(cleanText(value).text, max);
  return text === '' ? undefined : text;
}

/** A short plain reason from the model: one line, cut, never markup that matters (it is shown as text). */
export const cleanReason = (value: unknown): string =>
  clip(cleanText(typeof value === 'string' ? value : '').text, 300);
