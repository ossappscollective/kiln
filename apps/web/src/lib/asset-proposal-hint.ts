import { t } from './i18n/t.ts';

/**
 * The small line on the Releases list: "3 store asset changes proposed" (docs/api/release-asset-proposal.md "Summary", ADR 0064). The wire
 * type of `GET /apps/{id}/release/asset-proposal/summary` and the one rule for when the line is drawn. Pure.
 */
export type ProposalSummary = {
  available: boolean;
  reason: string | null;
  version: string | null;
  track: string | null;
  state: 'open' | 'skipped' | 'later';
  count: number;
  texts: number;
  graphics: number;
  locked: boolean;
  cached: boolean;
  computedAt: number;
};

/** Drawn only for an app with a repository, when the repository was compared, the proposal was not skipped for this release and something is proposed. */
export function proposalHint(summary: ProposalSummary | null, hasRepository: boolean): { count: number; texts: number; graphics: number } | null {
  if (!hasRepository || summary === null || !summary.available) return null;
  if (summary.state === 'skipped' || summary.count <= 0) return null;
  return { count: summary.count, texts: summary.texts, graphics: summary.graphics };
}

export const proposalHintText = (count: number): string => t('release:assetHint.count', { count });
