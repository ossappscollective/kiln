import { escapeHtml, mailLink, setMailLinkOrigin } from '../../services/mail-template.ts';
import {
  emailButton,
  emailCalloutHtml,
  emailChip,
  emailFooter,
  emailHeading,
  emailItemRow,
  emailLinkHtml,
  emailMutedSpan,
  emailParagraphHtml,
  emailRow,
  emailShell,
  emailSpacer,
  type EmailTone,
} from '../../mail/layout.ts';
import { translator } from '../../i18n/catalogs.ts';
import { isServerLocale, SOURCE_LOCALE } from '../../i18n/runtime.ts';
import type { AlertData, AlertDef, AlertSeverity } from './catalog-core.ts';
import { alertText } from './text.ts';

/**
 * The look of an alert email (docs/alerts.md): what happened, what to do about it and a button that opens the right screen of the
 * app, as an HTML part with a plain text twin. Pure apart from the link origin, which `createApp` sets from KILN_PUBLIC_ORIGIN (the
 * address people open the app at). Without it the email still says where to go ("Credentials"), it just has no link: the server
 * cannot know the address it is reached at from a background job. Everything that reaches the HTML is escaped; the data is ids,
 * names and numbers only (see `redactAlertData`).
 *
 * Language (docs/i18n-server.md): every sentence of the email is in the `alerts` and `digest` catalogs
 * (`apps/server/locales/<namespace>/<language>.json`); the language is the recipient's (`i18n/user-locale.ts`), English when unknown.
 * In English the title and body are the ones stored with the alert (the same English text); in another language they are
 * rebuilt from the alert type and its data (`text.ts`), and a type with no entry keeps the stored text.
 */

/** Installs the origin links are built on (the one of every email, see services/mail-template.ts). */
export const setAlertLinkOrigin = setMailLinkOrigin;

/** A screen to go to: `path` is the address inside the app (`#/credentials`), `where` says it in words for an email without links. */
export type AlertAction = { label: string; path: string; where: string };

/** What to tell the reader beyond the alert text: a short "how to fix it" and the screens to open. */
export type AlertGuide = { hint?: string; primary?: AlertAction; secondary?: AlertAction[] };

const enc = encodeURIComponent;
const localeOf = (locale: string | undefined): string =>
  locale && isServerLocale(locale) ? locale : SOURCE_LOCALE;

type Where = readonly [key: string, params?: Record<string, string>];
/** An action before it is put into words: catalog keys (`alerts:action.<label>`, `alerts:where.<where>`) and the address. */
type ActionSpec = { label: string; path: string; where: Where };
type GuideSpec = { hint?: string; primary?: ActionSpec; secondary?: ActionSpec[] };

const appAt = (d: AlertData, section?: string): string =>
  typeof d.appId === 'string' && d.appId !== ''
    ? `#/portfolio/${enc(d.appId)}${section ? `/${section}` : ''}`
    : '#/portfolio';

const openApp = (d: AlertData, section: string | undefined, label: string): ActionSpec => ({
  label,
  path: appAt(d, section),
  where: [
    section ? `where.appSection.${section}` : 'where.app',
    { app: String(d.appName ?? d.appId ?? '') },
  ],
});
/** The TestFlight view of an app: the Reviews page, view TestFlight. */
const openTestflight = (d: AlertData): ActionSpec => ({
  label: 'openTestflight',
  path: `${appAt(d, 'reviews')}?view=testflight`,
  where: ['where.appSection.reviews', { app: String(d.appName ?? d.appId ?? '') }],
});
/** The Ratings view of an app (Reviews page), where app health sits under the ratings. */
const openHealth = (d: AlertData): ActionSpec => ({
  label: 'openHealth',
  path: `${appAt(d, 'reviews')}?view=ratings`,
  where: ['where.appSection.reviews', { app: String(d.appName ?? d.appId ?? '') }],
});
const credentials: ActionSpec = {
  label: 'checkCredentials',
  path: '#/credentials',
  where: ['where.credentials'],
};
const settingsSecurity = (label: string, where = 'where.settingsSecurity'): ActionSpec => ({
  label,
  path: '#/settings?view=security',
  where: [where],
});

/** Where each alert type sends the reader, and the one sentence that says how to fix it. Types missing here only get the footer links. */
const guides: Record<string, (d: AlertData) => GuideSpec> = {
  'release.rejected': (d) => ({
    hint: 'rejected',
    primary: openApp(d, 'releases', 'seeRejection'),
  }),
  'release.approved': (d) => ({
    hint: 'approved',
    primary: openApp(d, 'releases', 'openRelease'),
  }),
  'release.live': (d) => ({ primary: openApp(d, 'releases', 'openRelease') }),
  'release.in_review': (d) => ({ primary: openApp(d, 'releases', 'openRelease') }),
  'release.halted': (d) => ({
    hint: 'halted',
    primary: openApp(d, 'releases', 'openRelease'),
  }),
  'release.stalled': (d) => ({
    hint: 'stalled',
    primary: openApp(d, 'releases', 'seeWhatItWaitsFor'),
  }),
  'plan.deadline_overdue': (d) => ({ primary: openApp(d, 'releases', 'openPlan') }),
  'plan.deadline_due_soon': (d) => ({ primary: openApp(d, 'releases', 'openPlan') }),
  'plan.rollout_step_due': (d) => ({ primary: openApp(d, 'releases', 'openPlan') }),
  'review.low_rating': (d) => ({ primary: openApp(d, 'reviews', 'readReviews') }),
  'review.new': (d) => ({ primary: openApp(d, 'reviews', 'readReviews') }),
  'testflight.feedback': (d) => ({ primary: openTestflight(d) }),
  'testflight.crash': (d) => ({ primary: openTestflight(d) }),
  'eas.build_failed': (d) => ({ primary: openApp(d, 'builds', 'seeBuilds') }),
  'eas.submission_failed': (d) => ({ primary: openApp(d, 'builds', 'seeBuilds') }),
  'eas.update_rollout_stuck': (d) => ({ primary: openApp(d, 'builds', 'seeBuilds') }),
  'review.unanswered': (d) => ({
    hint: 'unanswered',
    primary: openApp(d, 'reviews', 'answerReviews'),
  }),
  'rating.dropped': (d) => ({ primary: openApp(d, 'reviews', 'readReviews') }),
  'health.crash_regression': (d) => ({ primary: openHealth(d) }),
  'review.sync_failed': (d) => ({
    hint: 'sync',
    primary: openApp(d, 'reviews', 'seeWhy'),
    secondary: d.competitor === true ? [] : [credentials],
  }),
  'store.sync_failed': (d) => ({
    hint: 'sync',
    primary: openApp(d, undefined, 'seeWhySyncFails'),
    secondary: [credentials],
  }),
  'listing.read_failing': (d) => ({
    hint: 'sync',
    primary: openApp(d, 'listing', 'seeWhy'),
    secondary: [credentials],
  }),
  'credential.invalid': () => ({
    hint: 'credentialInvalid',
    primary: { ...credentials, label: 'fixCredential' },
  }),
  'listing.drift': (d) => ({
    hint: 'drift',
    primary: openApp(d, 'listing', 'reviewDifferences'),
  }),
  'ci.run_failed': (d) => ({ hint: 'ciFailed', primary: openApp(d, 'builds', 'seeBuilds') }),
  'changeset.failed': () => ({
    hint: 'changesetFailed',
    primary: { label: 'openRepositories', path: '#/repositories', where: ['where.repositories'] },
  }),
  'pending.stale': (d) => ({
    hint: 'pendingStale',
    primary: openApp(d, 'pending', 'reviewChanges'),
  }),
  'analytics.sync_failing': (d) => ({
    hint: 'analytics',
    primary: openApp(d, 'analytics', 'seeWhy'),
    secondary: [credentials],
  }),
  'aso.rank_dropped': (d) => ({ primary: openApp(d, 'aso', 'seeKeywords') }),
  'aso.competitor_changed': (d) => ({ primary: openApp(d, 'aso', 'seeCompetitors') }),
  'competitor.listing_changed': (d) => ({ primary: openApp(d, 'aso', 'seeCompetitors') }),
  'ai.suggestion_ready': (d) => ({ primary: openApp(d, undefined, 'seeSuggestion') }),
  'security.stepup_failed': () => ({
    hint: 'stepupFailed',
    primary: settingsSecurity('openSettings'),
  }),
  'security.recovery_used': () => ({
    hint: 'recoveryUsed',
    primary: settingsSecurity('openSettings'),
  }),
  'security.token_created': () => ({
    hint: 'tokenCreated',
    primary: { label: 'seeApiTokens', path: '#/tokens', where: ['where.apiTokens'] },
  }),
  'security.member_added': () => ({
    primary: { label: 'seeMembers', path: '#/members', where: ['where.members'] },
  }),
  'system.smtp_failing': () => ({
    hint: 'smtp',
    primary: settingsSecurity('fixMailServer', 'where.mailServer'),
  }),
};

/** The guide of an alert type in `locale` (English by default): its hint and its screens, in words. */
export const alertGuide = (typeId: string, data: AlertData, locale?: string): AlertGuide => {
  const spec = guides[typeId]?.(data);
  if (!spec) return {};
  const t = translator(localeOf(locale));
  const say = (a: ActionSpec): AlertAction => ({
    label: t(`alerts:action.${a.label}`),
    path: a.path,
    where: t(`alerts:${a.where[0]}`, a.where[1]),
  });
  return {
    ...(spec.hint ? { hint: t(`alerts:hint.${spec.hint}`) } : {}),
    ...(spec.primary ? { primary: say(spec.primary) } : {}),
    ...(spec.secondary ? { secondary: spec.secondary.map(say) } : {}),
  };
};

/** The title to show in `locale`: rebuilt from the type and its data, or the stored one (English, or a type with no catalog entry). */
export const alertTitleIn = (
  typeId: string,
  data: AlertData,
  stored: string,
  locale?: string,
): string => {
  const language = localeOf(locale);
  return language === SOURCE_LOCALE ? stored : (alertText(typeId, data, language)?.title ?? stored);
};

const linkTo = (a: AlertAction): string | undefined => mailLink(a.path);

/** The status colours (mail/layout.ts) each severity wears. */
const toneOf: Record<AlertSeverity, EmailTone> = { critical: 'bad', warning: 'warn', info: 'info' };

export type RenderedEmail = { subject: string; text: string; html: string };

const alertsPath = '#/alerts';

/** The quiet last row: why the person gets this email, with a link to the alert settings when the origin is known. */
const footerRow = (t: ReturnType<typeof translator>): string => {
  const href = mailLink(alertsPath);
  return emailFooter(
    href
      ? t.html('alerts:mail.footer.link', undefined, {
          link: (inner) => emailLinkHtml(href, inner),
        })
      : t.html('alerts:mail.footer.noLink'),
  );
};

const footerText = (t: ReturnType<typeof translator>): string => {
  const href = mailLink(alertsPath);
  return href
    ? t('alerts:mail.footerText.link', { href })
    : t('alerts:mail.footerText.noLink');
};

/** One alert as an email in `locale` (the recipient's language; English when absent). `count` is how many times it happened when it is shown again. */
export function renderAlertEmail(
  def: AlertDef,
  input: {
    title: string;
    body: string;
    severity: AlertSeverity;
    data: AlertData;
    count?: number;
    locale?: string;
  },
): RenderedEmail {
  const { severity, data } = input;
  const locale = localeOf(input.locale);
  const t = translator(locale);
  const translated = locale === SOURCE_LOCALE ? undefined : alertText(def.id, data, locale);
  const title = translated?.title ?? input.title;
  const body = translated?.body ?? input.body;
  const count = input.count ?? 1;
  const guide = alertGuide(def.id, data, locale);
  const subject = t('alerts:mail.subject', {
    severity: t(`alerts:mail.severityTag.${severity}`),
    title,
  }).slice(0, 200);

  const textLines = [title, '', body];
  if (count > 1) textLines.push('', t('alerts:mail.repeated.text', { count }));
  if (guide.hint) textLines.push('', t('alerts:mail.whatToDo.text', { hint: guide.hint }));
  const actions = [guide.primary, ...(guide.secondary ?? [])].filter(
    (a): a is AlertAction => a !== undefined,
  );
  for (const a of actions) {
    const href = linkTo(a);
    textLines.push(
      '',
      href
        ? t('alerts:mail.actionLink', { label: a.label, href })
        : t('alerts:mail.actionNoLink', { label: a.label, where: a.where }),
    );
  }
  textLines.push(
    '',
    '--',
    t('alerts:mail.meta', { type: def.id, severity: t(`alerts:mail.severityTag.${severity}`) }),
    footerText(t),
  );

  const secondary = (guide.secondary ?? [])
    .map((a) => {
      const href = linkTo(a);
      return href ? emailLinkHtml(href, escapeHtml(a.label), true) : '';
    })
    .filter((s) => s !== '');
  const primary = guide.primary
    ? emailButton({
        label: guide.primary.label,
        href: linkTo(guide.primary),
        where: guide.primary.where,
      }, t)
    : '';
  const repeated = count > 1 ? ` ${emailMutedSpan(t('alerts:mail.repeated.inline', { count }))}` : '';
  const inner = [
    emailRow(
      `<div style="margin:0 0 14px;">${emailChip(t(`alerts:mail.severity.${severity}`), toneOf[severity])}</div>${emailHeading(title)}${emailParagraphHtml(escapeHtml(body) + repeated)}`,
      28,
    ),
    guide.hint ? emailRow(emailCalloutHtml(t.html('alerts:mail.whatToDo.html', { hint: guide.hint })), 20) : '',
    primary ? emailRow(primary, 24) : '',
    secondary.length > 0
      ? emailRow(
          emailParagraphHtml(`${escapeHtml(t('alerts:mail.also'))} ${secondary.join(' &nbsp;·&nbsp; ')}`, true),
          18,
        )
      : '',
    emailSpacer(28),
    footerRow(t),
  ].join('\n');

  return { subject, text: textLines.join('\n'), html: emailShell(inner, title, locale, subject) };
}

/** The digest in `locale`: one line per alert, each with where to go, in the same frame. A `title` is shown as given (see `alertTitleIn`). */
export function renderDigestEmail(
  items: readonly {
    title: string;
    severity: AlertSeverity;
    count: number;
    action: AlertAction | undefined;
  }[],
  locale?: string,
): RenderedEmail {
  const language = localeOf(locale);
  const t = translator(language);
  const n = items.length;
  const subject = t('digest:subject', { count: n });
  const tag = (s: AlertSeverity) => t(`alerts:mail.severityTag.${s}`);
  const text = [
    t('digest:intro', { count: n }),
    '',
    ...items.map((i) => {
      const href = i.action ? linkTo(i.action) : undefined;
      const line =
        i.count > 1
          ? t('digest:item.repeated', { severity: tag(i.severity), title: i.title, count: i.count })
          : t('digest:item', { severity: tag(i.severity), title: i.title });
      return `${line}${href && i.action ? `\n  ${t('alerts:mail.actionLink', { label: i.action.label, href })}` : ''}`;
    }),
    '',
    t('digest:footer'),
  ].join('\n');
  const rows = items
    .map((i) => {
      const href = i.action ? linkTo(i.action) : undefined;
      const repeated =
        i.count > 1 ? ` ${emailMutedSpan(t('alerts:mail.repeated.inline', { count: i.count }))}` : '';
      const link = href && i.action ? `<br>${emailLinkHtml(href, escapeHtml(i.action.label), true)}` : '';
      return emailItemRow(`${emailChip(t(`alerts:mail.severity.${i.severity}`), toneOf[i.severity])}<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>${emailParagraphHtml(escapeHtml(i.title) + repeated + link)}`);
    })
    .join('\n');
  const inner = `${emailRow(emailHeading(t('digest:heading', { count: n })), 28, 18)}
${rows}
${emailSpacer(8)}
${footerRow(t)}`;
  return { subject, text, html: emailShell(inner, subject, language, subject) };
}
