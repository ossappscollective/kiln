import {
  escapeHtml,
  mailBar,
  mailButton,
  mailFooter,
  mailLink,
  mailShell,
  setMailLinkOrigin,
} from '../../services/mail-template.ts';
import type { AlertData, AlertDef, AlertSeverity } from './catalog-core.ts';

/**
 * The look of an alert email (docs/alerts.md): what happened, what to do about it and a button that opens the right screen of the
 * app, as an HTML part with a plain text twin. Pure apart from the link origin, which `createApp` sets from MRM_PUBLIC_ORIGIN (the
 * address people open the app at). Without it the email still says where to go ("Credentials"), it just has no link: the server
 * cannot know the address it is reached at from a background job. Everything that reaches the HTML is escaped; the data is ids,
 * names and numbers only (see `redactAlertData`).
 */

/** Installs the origin links are built on (the one of every email, see services/mail-template.ts). */
export const setAlertLinkOrigin = setMailLinkOrigin;

/** A screen to go to: `path` is the address inside the app (`#/credentials`), `where` says it in words for an email without links. */
export type AlertAction = { label: string; path: string; where: string };

/** What to tell the reader beyond the alert text: a short "how to fix it" and the screens to open. */
export type AlertGuide = { hint?: string; primary?: AlertAction; secondary?: AlertAction[] };

const enc = encodeURIComponent;
const appName = (d: AlertData) => String(d.appName ?? 'the app');
const appAt = (d: AlertData, section?: string): string =>
  typeof d.appId === 'string' && d.appId !== ''
    ? `#/portfolio/${enc(d.appId)}${section ? `/${section}` : ''}`
    : '#/portfolio';

const openApp = (d: AlertData, section?: string, label?: string): AlertAction => ({
  label: label ?? `Open ${appName(d)}`,
  path: appAt(d, section),
  where: `${appName(d)}${section ? `, ${section}` : ''}`,
});
const credentials: AlertAction = {
  label: 'Check the credentials',
  path: '#/credentials',
  where: 'Credentials',
};
const syncHint =
  'Open the app to see the reason. The usual cause is a credential that expired or lost access: test it on the Credentials screen and replace the key if the test fails.';

/** Where each alert type sends the reader, and the one sentence that says how to fix it. Types missing here only get the footer links. */
const guides: Record<string, (d: AlertData) => AlertGuide> = {
  'release.rejected': (d) => ({
    hint: 'Read the reason the store gave, fix it and send a new build for review.',
    primary: openApp(d, 'releases', 'See the rejection'),
  }),
  'release.approved': (d) => ({
    hint: 'It is approved. Release it when you are ready.',
    primary: openApp(d, 'releases', 'Open the release'),
  }),
  'release.live': (d) => ({ primary: openApp(d, 'releases', 'Open the release') }),
  'release.in_review': (d) => ({ primary: openApp(d, 'releases', 'Open the release') }),
  'release.halted': (d) => ({
    hint: 'Decide whether to resume the rollout or to fix the problem and release again.',
    primary: openApp(d, 'releases', 'Open the release'),
  }),
  'release.stalled': (d) => ({
    hint: 'Look at what the release is waiting for: a build, a review or a person.',
    primary: openApp(d, 'releases', 'See what it waits for'),
  }),
  'plan.deadline_overdue': (d) => ({ primary: openApp(d, 'releases', 'Open the plan') }),
  'plan.deadline_due_soon': (d) => ({ primary: openApp(d, 'releases', 'Open the plan') }),
  'plan.rollout_step_due': (d) => ({ primary: openApp(d, 'releases', 'Open the plan') }),
  'review.low_rating': (d) => ({ primary: openApp(d, 'reviews', 'Read the reviews') }),
  'review.new': (d) => ({ primary: openApp(d, 'reviews', 'Read the reviews') }),
  'review.unanswered': (d) => ({
    hint: 'Answering reviews is quick here: write a reply or let the assistant suggest one.',
    primary: openApp(d, 'reviews', 'Answer the reviews'),
  }),
  'rating.dropped': (d) => ({ primary: openApp(d, 'reviews', 'Read the reviews') }),
  'review.sync_failed': (d) => ({
    hint: syncHint,
    primary: openApp(d, 'reviews', 'See why'),
    secondary: [credentials],
  }),
  'store.sync_failed': (d) => ({
    hint: syncHint,
    primary: openApp(d, undefined, 'See why the sync fails'),
    secondary: [credentials],
  }),
  'listing.read_failing': (d) => ({
    hint: syncHint,
    primary: openApp(d, 'listing', 'See why'),
    secondary: [credentials],
  }),
  'credential.invalid': () => ({
    hint: 'Test the credential. If the test fails, the key was revoked or expired: add a new one and replace it.',
    primary: { ...credentials, label: 'Fix the credential' },
  }),
  'listing.drift': (d) => ({
    hint: 'The store text no longer matches what you staged. Review the differences and pull or push.',
    primary: openApp(d, 'listing', 'Review the differences'),
  }),
  'ci.run_failed': (d) => ({
    hint: 'Open the run in your CI to read the log, fix it and run it again.',
    primary: openApp(d, 'builds', 'See the builds'),
  }),
  'changeset.failed': () => ({
    hint: 'The change could not be applied to the repository. Open it to see why and try again.',
    primary: { label: 'Open the repositories', path: '#/repositories', where: 'Repositories' },
  }),
  'pending.stale': (d) => ({
    hint: 'Changes have been waiting for a while. Review them and publish, or discard them.',
    primary: openApp(d, 'pending', 'Review the changes'),
  }),
  'analytics.sync_failing': (d) => ({
    hint: 'Open the analytics setup of the app: the report access or the credential usually needs attention.',
    primary: openApp(d, 'analytics', 'See why'),
    secondary: [credentials],
  }),
  'aso.rank_dropped': (d) => ({ primary: openApp(d, 'aso', 'See the keywords') }),
  'aso.competitor_changed': (d) => ({ primary: openApp(d, 'aso', 'See the competitors') }),
  'ai.suggestion_ready': (d) => ({ primary: openApp(d, undefined, 'See the suggestion') }),
  'security.stepup_failed': () => ({
    hint: 'If this was not you, change your password and review the sign-in methods.',
    primary: {
      label: 'Open the settings',
      path: '#/settings?view=security',
      where: 'Settings, Security',
    },
  }),
  'security.recovery_used': () => ({
    hint: 'A recovery code was used. If this was not you, change your password and make new codes.',
    primary: {
      label: 'Open the settings',
      path: '#/settings?view=security',
      where: 'Settings, Security',
    },
  }),
  'security.token_created': () => ({
    hint: 'If you do not know this token, revoke it.',
    primary: { label: 'See the API tokens', path: '#/tokens', where: 'API tokens' },
  }),
  'security.member_added': () => ({
    primary: { label: 'See the members', path: '#/members', where: 'Members' },
  }),
  'system.smtp_failing': () => ({
    hint: 'Alert emails are not getting out. Check the mail server settings and send a test.',
    primary: {
      label: 'Fix the mail server',
      path: '#/settings?view=security',
      where: 'Settings, Security, Mail server',
    },
  }),
};

export const alertGuide = (typeId: string, data: AlertData): AlertGuide =>
  guides[typeId]?.(data) ?? {};

const alertsSettings: AlertAction = {
  label: 'Change which alerts you get',
  path: '#/alerts',
  where: 'Alerts',
};

const linkTo = (a: AlertAction): string | undefined => mailLink(a.path);

const toneOf: Record<AlertSeverity, { bar: string; chip: string; label: string }> = {
  critical: { bar: '#c0392b', chip: '#fdecea', label: 'Critical' },
  warning: { bar: '#d68910', chip: '#fef5e7', label: 'Needs attention' },
  info: { bar: '#2e6bd3', chip: '#eaf1fc', label: 'For your information' },
};

export type RenderedEmail = { subject: string; text: string; html: string };

const button = (a: AlertAction, bar: string): string =>
  mailButton({ label: a.label, href: linkTo(a), where: a.where }, bar);

const footerLinks = (): string => {
  const href = linkTo(alertsSettings);
  const settings = href
    ? `<a href="${escapeHtml(href)}" style="color:#52606d;">${escapeHtml(alertsSettings.label)}</a>`
    : 'Change your choices in Alerts.';
  return mailFooter(`You get this email because of your alert settings. ${settings}`);
};

/** One alert as an email. `count` is how many times it happened when it is shown again. */
export function renderAlertEmail(
  def: AlertDef,
  input: {
    title: string;
    body: string;
    severity: AlertSeverity;
    data: AlertData;
    count?: number;
  },
): RenderedEmail {
  const { title, body, severity, data } = input;
  const count = input.count ?? 1;
  const guide = alertGuide(def.id, data);
  const tone = toneOf[severity];
  const subject = `[${severity}] ${title}`.slice(0, 200);

  const textLines = [title, '', body];
  if (count > 1) textLines.push('', `This happened ${count} times.`);
  if (guide.hint) textLines.push('', `What to do: ${guide.hint}`);
  const actions = [guide.primary, ...(guide.secondary ?? [])].filter(
    (a): a is AlertAction => a !== undefined,
  );
  for (const a of actions) {
    const href = linkTo(a);
    textLines.push(
      '',
      href ? `${a.label}: ${href}` : `${a.label}: open Kiln, ${a.where}.`,
    );
  }
  const settingsHref = linkTo(alertsSettings);
  textLines.push(
    '',
    '--',
    `Alert type: ${def.id}. Severity: ${severity}.`,
    settingsHref
      ? `You get this email because of your alert settings. ${alertsSettings.label}: ${settingsHref}`
      : 'You get this email because of your alert settings in Kiln. Change them in Alerts.',
  );

  const secondary = (guide.secondary ?? [])
    .map((a) => {
      const href = linkTo(a);
      return href
        ? `<a href="${escapeHtml(href)}" style="color:${tone.bar};font-weight:600;">${escapeHtml(a.label)}</a>`
        : '';
    })
    .filter((s) => s !== '');
  const inner = `${mailBar(tone.bar)}
<tr><td style="padding:24px 28px 4px;">
<span style="display:inline-block;background:${tone.chip};color:${tone.bar};font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;">${tone.label}</span>
<h1 style="margin:12px 0 8px;font-size:20px;line-height:1.3;">${escapeHtml(title)}</h1>
<p style="margin:0;font-size:15px;line-height:1.55;color:#323f4b;">${escapeHtml(body)}${count > 1 ? ` <span style="color:#7b8794;">(${count} times)</span>` : ''}</p>
</td></tr>
${
  guide.hint
    ? `<tr><td style="padding:16px 28px 0;"><div style="background:#f5f7fa;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:#323f4b;"><strong>What to do.</strong> ${escapeHtml(guide.hint)}</div></td></tr>`
    : ''
}
${guide.primary ? `<tr><td style="padding:20px 28px 0;">${button(guide.primary, tone.bar)}</td></tr>` : ''}
${secondary.length > 0 ? `<tr><td style="padding:14px 28px 0;font-size:14px;">Also: ${secondary.join(' &nbsp;·&nbsp; ')}</td></tr>` : ''}
<tr><td style="height:24px;font-size:0;line-height:0;">&nbsp;</td></tr>
${footerLinks()}`;

  return { subject, text: textLines.join('\n'), html: mailShell(inner, title) };
}

/** The digest: one line per alert, each with where to go, in the same frame. */
export function renderDigestEmail(
  items: readonly {
    title: string;
    severity: AlertSeverity;
    count: number;
    action: AlertAction | undefined;
  }[],
): RenderedEmail {
  const n = items.length;
  const subject = `Alert digest: ${n} alert${n === 1 ? '' : 's'}`;
  const text = [
    `${n} alert${n === 1 ? '' : 's'} since your last digest:`,
    '',
    ...items.map((i) => {
      const href = i.action ? linkTo(i.action) : undefined;
      return `- [${i.severity}] ${i.title}${i.count > 1 ? ` (${i.count} times)` : ''}${href ? `\n  ${i.action?.label}: ${href}` : ''}`;
    }),
    '',
    'You get this digest because of your alert settings in Kiln. Change them in Alerts.',
  ].join('\n');
  const rows = items
    .map((i) => {
      const tone = toneOf[i.severity];
      const href = i.action ? linkTo(i.action) : undefined;
      return `<tr><td style="padding:12px 28px;border-top:1px solid #e4e7eb;font-size:14px;line-height:1.5;">
<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${tone.bar};margin-right:8px;"></span>${escapeHtml(i.title)}${i.count > 1 ? ` <span style="color:#7b8794;">(${i.count} times)</span>` : ''}
${href && i.action ? `<br><a href="${escapeHtml(href)}" style="color:${tone.bar};font-weight:600;font-size:13px;">${escapeHtml(i.action.label)}</a>` : ''}</td></tr>`;
    })
    .join('\n');
  const inner = `${mailBar('#2e6bd3')}
<tr><td style="padding:24px 28px 16px;"><h1 style="margin:0;font-size:20px;line-height:1.3;">${n} alert${n === 1 ? '' : 's'} since your last digest</h1></td></tr>
${rows}
${footerLinks()}`;
  return { subject, text, html: mailShell(inner, subject) };
}
