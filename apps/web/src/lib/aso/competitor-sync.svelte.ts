/**
 * One counter that moves when a followed competitor is added or removed anywhere (Insights, ASO, competitors), so the Reviews page
 * section "Competitors" reads its list again without a reload. Read `competitorSync.version` inside an effect.
 */
export const competitorSync = $state({ version: 0 });

export function bumpCompetitors(): void {
  competitorSync.version += 1;
}
