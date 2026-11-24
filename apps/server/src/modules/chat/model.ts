import { SERVER_LOCALES } from '../../i18n/runtime.ts';
import type { AlertSeverity } from '../alerts/catalog.ts';
import { emailTokens } from '../../mail/layout.ts';

/**
 * Chat integrations (docs/chat-integrations.md, docs/adr/0047-chat-integrations.md): the shared vocabulary. A destination is one
 * incoming webhook of Slack or Microsoft Teams; its URL is the secret. Pure: no database, no network.
 */

export const chatProviders = ['slack', 'teams'] as const;
export type ChatProvider = (typeof chatProviders)[number];
export const isChatProvider = (v: unknown): v is ChatProvider =>
  typeof v === 'string' && (chatProviders as readonly string[]).includes(v);

/** The languages a destination can use: the server's catalogs. */
export const chatLocales: readonly string[] = SERVER_LOCALES;

/**
 * The hosts a provider's webhook URL comes from, checked when a destination is saved and again at every send. A leading `*.` means
 * "any sub-domain". Anything else needs the destination's explicit `allowAnyHost`. Verified against Slack's and Microsoft's docs
 * where noted in the ADR; the Teams hosts of the Workflows app are the least documented.
 */
export const providerHosts: Record<ChatProvider, readonly string[]> = {
  slack: ['hooks.slack.com'],
  teams: [
    // Workflows (Power Automate) webhook triggers: the current form is <environment>.<region>.environment.api.powerplatform.com.
    '*.powerplatform.com',
    // The older Workflows form (retired by Microsoft on 30 November 2025, still accepted so an existing URL keeps working).
    '*.logic.azure.com',
    // Office 365 connector webhooks (retired by Microsoft; kept so an old URL gives a clear failure, not a refusal).
    '*.webhook.office.com',
  ],
};

export function hostAllowed(provider: ChatProvider, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return providerHosts[provider].some((rule) =>
    rule.startsWith('*.')
      ? host.endsWith(rule.slice(1)) && host.length > rule.length - 1
      : host === rule,
  );
}

/** The last four characters of a URL: the only part ever shown (never the host path, which holds the secret). */
export const urlHint = (url: string): string => url.slice(-4);

export const chatDigestModes = ['off', 'daily'] as const;
export type ChatDigestMode = (typeof chatDigestModes)[number];

/** The accent of a message: the status colours of the emails, so every channel looks like one product. */
export const accentOf: Record<AlertSeverity, string> = {
  critical: emailTokens.light.tones.bad.ink,
  warning: emailTokens.light.tones.warn.ink,
  info: emailTokens.light.accent,
};

/** What a renderer needs, in the destination's language, with no markup: the renderers escape for their own syntax. */
export type ChatMessage = {
  severity: AlertSeverity;
  /** The notification text (also the plain text of a client that shows no card). */
  fallback: string;
  title: string;
  severityLabel: string;
  facts: { label: string; value: string }[];
  body: string;
  hint?: { label: string; text: string } | undefined;
  repeated?: string | undefined;
  /** Link buttons that open a Kiln page. Empty when the server has no public origin. */
  buttons: { label: string; url: string }[];
  /** Said in words when there is no link to give ("Open Kiln: Credentials."). */
  noLink?: string | undefined;
  footer: string;
};

export type ChatDigest = {
  title: string;
  heading: string;
  items: {
    severity: AlertSeverity;
    severityLabel: string;
    text: string;
    link?: { label: string; url: string } | undefined;
  }[];
  more?: string | undefined;
  buttons: { label: string; url: string }[];
  footer: string;
};

export type ChatPayloadKind = 'alert' | 'digest' | 'test';

/** Limits of the providers, checked by the renderers and their tests. */
export const limits = {
  slack: {
    blocks: 50,
    header: 150,
    sectionText: 3000,
    fields: 10,
    fieldText: 2000,
    buttonText: 75,
    buttonUrl: 3000,
    items: 40,
  },
  teams: { bytes: 28 * 1024 },
} as const;

/** The statuses of a chat delivery. */
export const chatStatuses = [
  'queued',
  'retrying',
  'sent',
  'failed',
  'skipped',
  'deferred',
] as const;

/**
 * The fixed vocabulary of the delivery log: a screen can explain each one, and nothing a provider said is ever stored. (The web app's
 * test reads this list and fails when a code has no sentence.)
 */
export const chatOutcomes = [
  'queued',
  'ok',
  'in_digest',
  'digest_sent',
  'rate_limited',
  'server_error',
  'timeout',
  'dns_failed',
  'network_error',
  'blocked_address',
  'host_not_allowed',
  'webhook_gone',
  'webhook_rejected',
  'payload_rejected',
  'rejected',
  'redirected',
  'disabled',
  'secret_unreadable',
] as const;
export type ChatOutcome = (typeof chatOutcomes)[number];
