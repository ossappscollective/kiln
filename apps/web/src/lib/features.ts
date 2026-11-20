/**
 * Features that are built but switched off in the web app. The code stays; flip a flag to bring the screens back.
 *
 * PLANS_ENABLED: release plans (a target date, a checklist, release notes per locale and a staged rollout schedule kept in our own
 * database; docs/api/plans.md). Off: the release page shows only the store state of each platform, the releases table has no
 * "Plan" column and the Overview raises nothing about overdue or blocked plans. The server routes, the tables and the alerts are
 * unchanged, so existing plans are kept.
 */
export const PLANS_ENABLED = false;
