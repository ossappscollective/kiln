// The pure state of the per-app Play reports bucket form (PlayBucketField): what is typed, what is saved, and what the buttons may do.
// Saved value: the app's own bucket id, or null while the app inherits the workspace (or account) bucket.
import { normalizeBucketId } from '@kiln/core';

export type BucketFormInput = {
  /** The app's own saved bucket, null when it inherits. Undefined while the setting is not loaded. */
  saved: string | null | undefined;
  /** "Use the workspace default" is chosen. */
  useDefault: boolean;
  /** What is typed in the field. */
  text: string;
  /** The bucket the app would inherit, null when none is set. */
  inherited: string | null;
  saving: boolean;
  testing: boolean;
  canManage: boolean;
};

export type BucketFormState = {
  /** The typed text, trimmed. */
  typed: string;
  /** The typed text as a bare bucket id (gs:// and Cloud Storage URLs reduced), undefined when empty or invalid. */
  normalized: string | undefined;
  valid: boolean;
  /** Why the typed value cannot be used: nothing typed in custom mode, or not a bucket. Null when fine or when the default is chosen. */
  problem: 'empty' | 'invalid' | null;
  /** The choice differs from what is saved. */
  dirty: boolean;
  canSave: boolean;
  canTest: boolean;
  /** What a save sends: null for "use the default", the bare id for a custom bucket, undefined when nothing can be sent. */
  saveValue: string | null | undefined;
  /** What a test sends: undefined tests the inherited value on the server. */
  testValue: string | undefined;
};

/** A bare id from what was pasted: `pubsite_prod_rev_123`, `gs://…`, or a Cloud Storage URL. */
export function normalizeBucketInput(raw: string): string | undefined {
  return normalizeBucketId(raw);
}

export function bucketFormState(i: BucketFormInput): BucketFormState {
  const typed = i.text.trim();
  const normalized = typed === '' ? undefined : normalizeBucketInput(typed);
  const valid = normalized !== undefined;
  const problem = i.useDefault ? null : typed === '' ? 'empty' : valid ? null : 'invalid';
  const loaded = i.saved !== undefined;
  const dirty = loaded && (i.useDefault ? i.saved !== null : normalized !== i.saved);
  const idle = i.canManage && loaded && !i.saving && !i.testing;
  const saveValue = i.useDefault ? null : normalized;
  return {
    typed,
    normalized,
    valid,
    problem,
    dirty,
    canSave: idle && dirty && saveValue !== undefined,
    canTest:
      i.canManage &&
      loaded &&
      !i.testing &&
      !i.saving &&
      (i.useDefault ? i.inherited !== null : valid),
    saveValue,
    testValue: i.useDefault ? undefined : normalized,
  };
}
