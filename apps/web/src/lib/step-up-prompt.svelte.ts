import { type StepUpNeed, withStepUp } from './step-up.ts';

/**
 * The one confirmation prompt of the app (docs/api/step-up.md). A screen that sends a hard action wraps the call in
 * `confirmed(...)`: when the server answers `step_up_required`, <StepUpHost /> (mounted once in the shell) opens the
 * StepUpDialog, and the call is made once more with the grant. Only that one answer is ever retried.
 */
type Prompt = { id: number; need: StepUpNeed; resolve: (grant: string | undefined) => void };

let current = $state<Prompt | null>(null);
let counter = 0;

export const stepUpPrompt = {
  get current(): Prompt | null {
    return current;
  },
};

export function requestStepUp(need: StepUpNeed): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (current) current.resolve(undefined);
    counter += 1;
    current = { id: counter, need, resolve };
  });
}

/** Called by the dialog: a grant, or undefined when the person cancelled. */
export function settleStepUp(grant: string | undefined): void {
  const prompt = current;
  current = null;
  prompt?.resolve(grant);
}

/** `run(grant?)` sends the hard action; `hash` is the preview or plan hash it carries (binds the grant to it). */
export function confirmed<T>(run: (grant?: string) => Promise<T>, hash?: string): Promise<T> {
  return withStepUp(run, requestStepUp, hash);
}
