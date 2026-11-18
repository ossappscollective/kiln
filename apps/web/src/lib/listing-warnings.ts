import { cleanWarnings } from './listing-sections.ts';

/**
 * The read problems of the listing of one or more stores as groups, for the one-line warnings pill
 * on the listing tab. Pure: it only turns what the screen already has into titles and lines.
 */

export type WarningGroup = {
  id: string;
  title: string;
  lines: string[];
  /** A closing sentence that says what the problem means; null when there is none. */
  note: string | null;
};

export type WarningSource = {
  appId: string;
  /** "iOS" or "Android". */
  platform: string;
  /** The error of the last store read, or null. */
  storeError: string | null;
  /** The warnings of the live store read (they are cleaned here). */
  warnings: readonly string[] | null | undefined;
  /** The error of the last repository read, or null (also when no repository is linked). */
  repoError: string | null;
};

export function warningGroups(sources: readonly WarningSource[]): WarningGroup[] {
  const out: WarningGroup[] = [];
  for (const s of sources) {
    if (s.storeError) {
      out.push({
        id: `${s.appId}:store-error`,
        title: `The last read of the ${s.platform} store listing failed`,
        lines: [s.storeError],
        note: 'The values are from the last successful read. The release sync is not affected.',
      });
    }
    const warnings = cleanWarnings(s.warnings ?? undefined);
    if (warnings.length > 0) {
      out.push({
        id: `${s.appId}:store-warnings`,
        title: `The ${s.platform} store read had warnings`,
        lines: warnings,
        note: 'Parts of the listing that could not be read are left out, not shown as empty.',
      });
    }
    if (s.repoError) {
      out.push({
        id: `${s.appId}:repo-error`,
        title: `The last read of the ${s.platform} repository listing failed`,
        lines: [s.repoError],
        note: null,
      });
    }
  }
  return out;
}

/** How many separate problems the groups hold. */
export const warningCountOf = (groups: readonly WarningGroup[]): number => groups.reduce((n, g) => n + g.lines.length, 0);
