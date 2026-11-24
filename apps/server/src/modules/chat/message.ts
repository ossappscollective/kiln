import { translator } from '../../i18n/catalogs.ts';
import { isServerLocale, SOURCE_LOCALE } from '../../i18n/runtime.ts';
import { mailLink } from '../../services/mail-template.ts';
import type { AlertData, AlertSeverity } from '../alerts/catalog.ts';
import { alertGuide, alertTitleIn } from '../alerts/email.ts';
import { alertText } from '../alerts/text.ts';
import type { ChatDigest, ChatMessage } from './model.ts';

/**
 * Builds the language independent model of a message (model.ts) from an alert. Every sentence comes from the `alerts` catalog (the
 * alert's own title, body, hint and button labels, the same as the emails) or the `chat` catalog (the frame), in the destination's
 * language. Links are built on the same origin as the emails (`mailLink`, KILN_PUBLIC_ORIGIN); without it there are no buttons and the
 * message names the screen in words. Nothing here concatenates sentence parts.
 */

const localeOf = (locale: string | undefined): string =>
  locale && isServerLocale(locale) ? locale : SOURCE_LOCALE;

const MAX = { title: 150, body: 2800, value: 200 };
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const platformName = (v: unknown): string | undefined =>
  v === 'ios' ? 'iOS' : v === 'macos' ? 'macOS' : v === 'android' ? 'Android' : undefined;

export type AlertMessageInput = {
  type: string;
  severity: AlertSeverity;
  /** The stored English title and body. */
  title: string;
  body: string;
  data: AlertData;
  count?: number | undefined;
  locale: string;
};

export function buildAlertMessage(input: AlertMessageInput): ChatMessage {
  const locale = localeOf(input.locale);
  const t = translator(locale);
  const { data } = input;
  const translated = locale === SOURCE_LOCALE ? undefined : alertText(input.type, data, locale);
  const title = cut(
    translated?.title ?? alertTitleIn(input.type, data, input.title, locale),
    MAX.title,
  );
  const body = cut(translated?.body ?? input.body, MAX.body);
  const guide = alertGuide(input.type, data, locale);
  const actions = [guide.primary, ...(guide.secondary ?? [])].filter((a) => a !== undefined);
  const buttons: { label: string; url: string }[] = [];
  for (const a of actions) {
    const url = mailLink(a.path);
    if (url && buttons.length < 3) buttons.push({ label: a.label, url });
  }
  const facts: { label: string; value: string }[] = [];
  const app = typeof data.appName === 'string' && data.appName ? data.appName : undefined;
  if (app) facts.push({ label: t('chat:field.app'), value: cut(app, MAX.value) });
  const platform = platformName(data.platform);
  if (platform) facts.push({ label: t('chat:field.platform'), value: platform });
  const version = typeof data.version === 'string' && data.version ? data.version : undefined;
  if (version) facts.push({ label: t('chat:field.version'), value: cut(version, MAX.value) });
  const severityLabel = t(`chat:severity.${input.severity}`);
  const count = input.count ?? 1;
  return {
    severity: input.severity,
    fallback: cut(`${severityLabel}: ${title}`, 300),
    title,
    severityLabel,
    facts,
    body,
    hint: guide.hint ? { label: t('chat:whatToDo'), text: cut(guide.hint, 500) } : undefined,
    repeated: count > 1 ? t('chat:repeated', { count }) : undefined,
    buttons,
    noLink:
      buttons.length === 0 && guide.primary
        ? t('chat:noLink', { where: guide.primary.where })
        : undefined,
    footer: t('chat:footer', { type: input.type }),
  };
}

/** The message of "Send test message": a normal card with an info accent, so the person sees what an alert looks like. */
export function buildTestMessage(input: { name: string; locale: string }): ChatMessage {
  const locale = localeOf(input.locale);
  const t = translator(locale);
  const title = t('chat:test.title');
  const origin = mailLink('#/chat');
  return {
    severity: 'info',
    fallback: title,
    title,
    severityLabel: t('chat:severity.info'),
    facts: [],
    body: cut(t('chat:test.body', { name: input.name }), MAX.body),
    hint: { label: t('chat:whatToDo'), text: t('chat:test.hint') },
    buttons: origin ? [{ label: t('chat:openKiln'), url: origin }] : [],
    footer: t('chat:footer.test'),
  };
}

export type DigestItemInput = {
  type: string;
  severity: AlertSeverity;
  title: string;
  data: AlertData;
  count: number;
};

export function buildDigest(input: {
  items: readonly DigestItemInput[];
  total: number;
  locale: string;
}): ChatDigest {
  const locale = localeOf(input.locale);
  const t = translator(locale);
  const shown = input.items.slice(0, 40);
  const hidden = input.total - shown.length;
  const home = mailLink('#/alerts');
  return {
    title: t('chat:digest.title'),
    heading: t('chat:digest.heading', { count: input.total }),
    items: shown.map((i) => {
      const title = cut(alertTitleIn(i.type, i.data, i.title, locale), MAX.title);
      const primary = alertGuide(i.type, i.data, locale).primary;
      const url = primary ? mailLink(primary.path) : undefined;
      return {
        severity: i.severity,
        severityLabel: t(`chat:severity.${i.severity}`),
        text: i.count > 1 ? t('chat:item.repeated', { title, count: i.count }) : title,
        ...(primary && url ? { link: { label: primary.label, url } } : {}),
      };
    }),
    more: hidden > 0 ? t('chat:digest.more', { count: hidden }) : undefined,
    buttons: home ? [{ label: t('chat:openKiln'), url: home }] : [],
    footer: t('chat:footer.digest'),
  };
}
