import { accentOf, type ChatDigest, type ChatMessage, limits } from './model.ts';

/**
 * Slack: a Block Kit message for an incoming webhook (docs/chat-integrations.md). The coloured bar is the only way to give a message an
 * accent in a webhook post, so the blocks sit in one `attachment` with a `color`. Limits (docs.slack.dev): 50 blocks per message,
 * header text 150 characters, section text 3000, at most 10 fields of 2000, button text 75 characters and url 3000.
 *
 * Escaping: in mrkdwn `&`, `<` and `>` are control characters (they start links and mentions such as `<!channel>`), so every dynamic
 * value has them replaced by the entities Slack asks for. Slack has no escape for `*`, `_`, `~` and the backtick, so those are
 * wrapped in zero-width spaces, which stops a value from formatting the text around it. Titles and bodies are sent as `plain_text`
 * objects, which Slack never parses.
 */

const L = limits.slack;
const ZWSP = '\u200b';

/** A dynamic value made safe inside a mrkdwn string. */
export function escapeMrkdwn(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, `${ZWSP}$1${ZWSP}`);
}

/** A url made safe inside `<url|label>`. */
const safeUrl = (url: string) =>
  url.replace(/\s/g, '%20').replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\|/g, '%7C');

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (text: string, max: number) => ({
  type: 'plain_text',
  text: cut(text, max),
  emoji: false,
});
const mrkdwn = (text: string, max: number) => ({ type: 'mrkdwn', text: cut(text, max) });

export type SlackPayload = {
  text?: string;
  attachments: { color: string; fallback: string; blocks: Record<string, unknown>[] }[];
};

function buttons(list: { label: string; url: string }[]): Record<string, unknown> | undefined {
  const elements = list
    .filter((b) => b.url.length <= L.buttonUrl)
    .slice(0, 5)
    .map((b) => ({ type: 'button', text: plain(b.label, L.buttonText), url: b.url }));
  return elements.length > 0 ? { type: 'actions', elements } : undefined;
}

export function renderSlackMessage(m: ChatMessage): SlackPayload {
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: plain(m.title, L.header) },
    { type: 'context', elements: [mrkdwn(escapeMrkdwn(m.severityLabel), L.sectionText)] },
    { type: 'section', text: plain(m.body, L.sectionText) },
  ];
  if (m.facts.length > 0) {
    blocks.push({
      type: 'section',
      fields: m.facts
        .slice(0, L.fields)
        .map((f) => mrkdwn(`*${escapeMrkdwn(f.label)}*\n${escapeMrkdwn(f.value)}`, L.fieldText)),
    });
  }
  if (m.hint) {
    blocks.push({
      type: 'section',
      text: mrkdwn(`*${escapeMrkdwn(m.hint.label)}*\n${escapeMrkdwn(m.hint.text)}`, L.sectionText),
    });
  }
  const actions = buttons(m.buttons);
  if (actions) blocks.push(actions);
  const notes = [m.repeated, m.noLink, m.footer].filter((s): s is string => Boolean(s));
  blocks.push({
    type: 'context',
    elements: notes.map((n) => mrkdwn(escapeMrkdwn(n), L.sectionText)),
  });
  return {
    attachments: [
      {
        color: accentOf[m.severity],
        fallback: cut(m.fallback, 300),
        blocks: blocks.slice(0, L.blocks),
      },
    ],
  };
}

export function renderSlackDigest(d: ChatDigest): SlackPayload {
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: plain(d.title, L.header) },
    { type: 'section', text: plain(d.heading, L.sectionText) },
  ];
  // Ten lines to a section keeps each one far below 3000 characters and the whole below 50 blocks.
  for (let i = 0; i < d.items.length; i += 10) {
    const lines = d.items.slice(i, i + 10).map((item) => {
      const link = item.link ? ` <${safeUrl(item.link.url)}|${escapeMrkdwn(item.link.label)}>` : '';
      return `*${escapeMrkdwn(item.severityLabel)}* ${escapeMrkdwn(item.text)}${link}`;
    });
    blocks.push({ type: 'section', text: mrkdwn(lines.join('\n'), L.sectionText) });
  }
  if (d.more)
    blocks.push({ type: 'context', elements: [mrkdwn(escapeMrkdwn(d.more), L.sectionText)] });
  const actions = buttons(d.buttons);
  if (actions) blocks.push(actions);
  blocks.push({ type: 'context', elements: [mrkdwn(escapeMrkdwn(d.footer), L.sectionText)] });
  return {
    attachments: [
      {
        color: accentOf.info,
        fallback: cut(`${d.title}: ${d.heading}`, 300),
        blocks: blocks.slice(0, L.blocks),
      },
    ],
  };
}
