import type { StoreId } from '@kiln/core';

/**
 * TestFlight beta feedback and crash submissions, Apple only (docs/adr/0049-testflight-feedback.md, docs/spikes/testflight-feedback.md).
 * Google Play has no counterpart in this feature: its closed testing feedback is not exposed by the Developer API. READ ONLY: no connector
 * here deletes or changes anything in App Store Connect (the API has delete endpoints; Kiln does not use them).
 */

export const BETA_FEEDBACK_KINDS = ['feedback', 'crash'] as const;
export type BetaFeedbackKind = (typeof BETA_FEEDBACK_KINDS)[number];
export const isBetaFeedbackKind = (value: unknown): value is BetaFeedbackKind =>
  typeof value === 'string' && (BETA_FEEDBACK_KINDS as readonly string[]).includes(value);

/** One screenshot of a feedback: the size only. The link is NOT kept (it expires; see `BetaScreenshotLink`). */
export type BetaScreenshot = { width: number | null; height: number | null };

/** What one TestFlight submission says, as read from the list. Every field Apple may omit is null; nothing here is trusted to be present. */
export type StoreBetaFeedback = {
  /** Apple's id of the submission. */
  id: string;
  kind: BetaFeedbackKind;
  /** Epoch milliseconds, from `createdDate`. */
  createdAt: number | null;
  /** Free text of the tester. Personal data: never logged. Empty when none. */
  comment: string;
  /** The email the tester gave or was invited with. Personal data. Null for a public link tester who gave none. */
  email: string | null;
  buildId: string | null;
  /** The build number (`builds.version`). */
  buildNumber: string | null;
  /** The marketing version (`preReleaseVersions.version`), when it could be read. */
  version: string | null;
  /** Apple's `appPlatform` (`IOS`, `MAC_OS`, ...). */
  platform: string | null;
  bundleId: string | null;
  deviceModel: string | null;
  deviceFamily: string | null;
  osVersion: string | null;
  locale: string | null;
  timeZone: string | null;
  architecture: string | null;
  connectionType: string | null;
  pairedWatch: string | null;
  appUptimeMs: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  batteryPercent: number | null;
  screenWidth: number | null;
  screenHeight: number | null;
  /** Screenshot feedback only. */
  screenshots: BetaScreenshot[];
};

export type ListBetaFeedbackResult = {
  items: StoreBetaFeedback[];
  /** False when a list stopped at its cap: Apple may have older items than are shown. */
  complete: boolean;
  /** Sentences for a person (never a store response). */
  warnings: string[];
  /** Whether each list was read. A list Apple refused (403 the key's role, 404) is false and has a warning. */
  feedbackRead: boolean;
  crashesRead: boolean;
};

/** A screenshot link as Apple gave it just now. Short lived: shown to the person who asked, never stored or logged. */
export type BetaScreenshotLink = {
  url: string;
  width: number | null;
  height: number | null;
  /** Epoch milliseconds, from `expirationDate`; null when Apple gave none. */
  expiresAt: number | null;
};

export interface StoreTestFlightFeedbackConnector {
  readonly store: StoreId;
  listFeedback(): Promise<ListBetaFeedbackResult>;
  /** The text of the crash log of a submission, or null when Apple has none (gone, or the submission carries no log). */
  readCrashLog(submissionId: string): Promise<string | null>;
  /** Fresh links of the screenshots of one feedback; empty when it has none or it is gone. */
  readScreenshots(submissionId: string): Promise<BetaScreenshotLink[]>;
}
