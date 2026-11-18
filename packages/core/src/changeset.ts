/**
 * A change set is the only way anything is written: UI edits, repo commits and
 * (in V2) assistant suggestions all produce one, and a person approves it.
 */

export type ActorType = 'user' | 'token' | 'assistant' | 'system';

export type ChangeSetTarget = 'repo' | 'store';

export type FileChange = {
  path: string;
  /** Content before the change. Absent for a new file. */
  before?: string;
  /** Content after the change. Absent for a deleted file. */
  after?: string;
};

/**
 * `applying` is held while a repository write is in flight, so a second apply cannot start;
 * `failed` is a write that did not land.
 */
export type ChangeSetStatus =
  | 'draft'
  | 'approved'
  | 'applying'
  | 'applied'
  | 'discarded'
  | 'failed';

export type ChangeSet = {
  id: string;
  workspaceId: string;
  summary: string;
  target: ChangeSetTarget;
  status: ChangeSetStatus;
  createdBy: { type: ActorType; id: string };
  files: FileChange[];
};

export type AuditEvent = {
  id: string;
  workspaceId: string;
  actor: { type: ActorType; id: string };
  action: string;
  target?: { type: string; id: string };
  detail?: Record<string, unknown>;
  at: number;
};
