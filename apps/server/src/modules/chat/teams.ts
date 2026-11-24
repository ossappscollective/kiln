import { type ChatDigest, type ChatMessage, limits } from './model.ts';

/**
 * Microsoft Teams: an Adaptive Card in a `message` envelope, the shape the Workflows app's "when a Teams webhook request is received"
 * trigger takes (docs.microsoft.com, learn.microsoft.com: attachments with contentType application/vnd.microsoft.card.adaptive).
 * The Office 365 connector webhooks are retired, so this is the only Teams target. A message may be 28 KB at most; the renderer drops
 * what it must (digest lines first, then the body is shortened) until the JSON fits. Only link buttons (`Action.OpenUrl`): no
 * `Action.Submit`, which needs a bot or a public endpoint (a later version, see the ADR).
 *
 * Escaping: text in a TextBlock is read as a small markdown, so every dynamic value has its markdown characters escaped with a
 * backslash. `<` and `>` are escaped too, which keeps `<at>` mentions and HTML out. The accent is the TextBlock colour and the
 * container style, never an emoji.
 */

export const CARD_SCHEMA = 'http://adaptivecards.io/schemas/adaptive-card.json';
export const CARD_VERSION = '1.4';

export function escapeTeams(value: string): string {
  return value.replace(/[\\`*_{}[\]()#+!|~<>]/g, '\\$&').replace(/^([-\d]+)(?=[.)\s])/gm, '\\$1');
}

const colorOf = { critical: 'Attention', warning: 'Warning', info: 'Accent' } as const;
const styleOf = { critical: 'attention', warning: 'warning', info: 'accent' } as const;

const safeUrl = (url: string) =>
  url.replace(/\s/g, '%20').replace(/\)/g, '%29').replace(/\(/g, '%28');
const open = (b: { label: string; url: string }) => ({
  type: 'Action.OpenUrl',
  title: b.label.slice(0, 100),
  url: b.url,
});

export type TeamsPayload = {
  type: 'message';
  attachments: { contentType: string; contentUrl: null; content: Record<string, unknown> }[];
};

const envelope = (body: unknown[], actions: unknown[]): TeamsPayload => ({
  type: 'message',
  attachments: [
    {
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: CARD_SCHEMA,
        type: 'AdaptiveCard',
        version: CARD_VERSION,
        msteams: { width: 'Full' },
        body,
        ...(actions.length > 0 ? { actions } : {}),
      },
    },
  ],
});

const size = (p: TeamsPayload) => Buffer.byteLength(JSON.stringify(p));

function messageCard(m: ChatMessage, bodyText: string): TeamsPayload {
  const body: unknown[] = [
    {
      type: 'Container',
      style: styleOf[m.severity],
      bleed: true,
      items: [
        {
          type: 'TextBlock',
          text: escapeTeams(m.title),
          weight: 'Bolder',
          size: 'Large',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: escapeTeams(m.severityLabel),
          color: colorOf[m.severity],
          isSubtle: true,
          spacing: 'None',
          wrap: true,
        },
      ],
    },
    { type: 'TextBlock', text: escapeTeams(bodyText), wrap: true },
  ];
  if (m.facts.length > 0) {
    body.push({
      type: 'FactSet',
      facts: m.facts.map((f) => ({ title: escapeTeams(f.label), value: escapeTeams(f.value) })),
    });
  }
  if (m.hint) {
    body.push({
      type: 'Container',
      style: 'emphasis',
      items: [
        { type: 'TextBlock', text: escapeTeams(m.hint.label), weight: 'Bolder', wrap: true },
        { type: 'TextBlock', text: escapeTeams(m.hint.text), wrap: true, spacing: 'None' },
      ],
    });
  }
  for (const note of [m.repeated, m.noLink]) {
    if (note) body.push({ type: 'TextBlock', text: escapeTeams(note), wrap: true, isSubtle: true });
  }
  body.push({
    type: 'TextBlock',
    text: escapeTeams(m.footer),
    size: 'Small',
    isSubtle: true,
    wrap: true,
  });
  return envelope(body, m.buttons.slice(0, 6).map(open));
}

export function renderTeamsMessage(m: ChatMessage): TeamsPayload {
  let text = m.body;
  let card = messageCard(m, text);
  // Shorten the body until the card fits. Everything else is short by construction.
  while (size(card) > limits.teams.bytes && text.length > 100) {
    text = `${text.slice(0, Math.floor(text.length * 0.7))}…`;
    card = messageCard(m, text);
  }
  return card;
}

function digestCard(d: ChatDigest, keep: number): TeamsPayload {
  const items = d.items.slice(0, keep);
  const body: unknown[] = [
    {
      type: 'Container',
      style: 'accent',
      bleed: true,
      items: [
        {
          type: 'TextBlock',
          text: escapeTeams(d.title),
          weight: 'Bolder',
          size: 'Large',
          wrap: true,
        },
        {
          type: 'TextBlock',
          text: escapeTeams(d.heading),
          isSubtle: true,
          spacing: 'None',
          wrap: true,
        },
      ],
    },
    ...items.map((item) => ({
      type: 'TextBlock',
      wrap: true,
      text: `**${escapeTeams(item.severityLabel)}** ${escapeTeams(item.text)}${
        item.link ? ` [${escapeTeams(item.link.label)}](${safeUrl(item.link.url)})` : ''
      }`,
    })),
  ];
  if (d.more)
    body.push({ type: 'TextBlock', text: escapeTeams(d.more), wrap: true, isSubtle: true });
  body.push({
    type: 'TextBlock',
    text: escapeTeams(d.footer),
    size: 'Small',
    isSubtle: true,
    wrap: true,
  });
  return envelope(body, d.buttons.slice(0, 6).map(open));
}

export function renderTeamsDigest(d: ChatDigest): TeamsPayload {
  let keep = d.items.length;
  let card = digestCard(d, keep);
  while (size(card) > limits.teams.bytes && keep > 1) {
    keep = Math.floor(keep * 0.8);
    card = digestCard(d, keep);
  }
  return card;
}
