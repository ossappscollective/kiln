import {
  type AnalyticsDimension,
  type AnalyticsErrorCode,
  type AnalyticsMetric,
  analyticsErrorMessages,
} from '@mrm/core';

/**
 * Shared types of the analytics readers (docs/adr/0017-analytics-foundation.md). An error carries a code from a FIXED vocabulary
 * (`analyticsErrorCodes` in core); its message is a plain sentence that never holds a URL, a token or a row of a report.
 */
export class AnalyticsError extends Error {
  readonly code: AnalyticsErrorCode;
  readonly status?: number;
  constructor(code: AnalyticsErrorCode, message?: string, status?: number) {
    super(message ?? analyticsErrorMessages[code]);
    this.name = 'AnalyticsError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** One daily fact. `dimension` is absent for a total. */
export type AnalyticsPoint = {
  /** YYYY-MM-DD. */
  date: string;
  metric: AnalyticsMetric;
  value: number;
  dimension?: { type: AnalyticsDimension; value: string };
};

/** What a parser reports about a table, so a preview can show it before anything is stored. */
export type ParseStats = {
  /** Data rows in the file. */
  rowsRead: number;
  /** Rows that contributed to a point. */
  rowsUsed: number;
  /** Rows without a readable date or number. */
  rowsUnreadable: number;
  /** Rows left out on purpose (another platform, another event, an update, a page that is not the product page). */
  rowsFiltered: number;
};
