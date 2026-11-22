import type { TimelineStep } from './portfolio.ts';

/**
 * The one-line reading of a release timeline: which step is current, out of how many, and the full list for the tooltip.
 * `index` is null when no step is current (the release has no place on the timeline). Pure.
 */
export type TimelineProgress = {
  index: number | null;
  total: number;
  current: TimelineStep | null;
  /** Every step label in order, for the tooltip ("Draft › Ready › In review"). */
  path: string;
};

export function timelineProgress(steps: readonly TimelineStep[]): TimelineProgress {
  const at = steps.findIndex((s) => s.position === 'current');
  return {
    index: at < 0 ? null : at + 1,
    total: steps.length,
    current: at < 0 ? null : (steps[at] as TimelineStep),
    path: steps.map((s) => s.label).join(' › '),
  };
}
