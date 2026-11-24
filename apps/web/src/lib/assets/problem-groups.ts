import {
  ASSET_KIND_LABELS,
  type AssetKind,
  type AssetProblem,
  type AssetSeverity,
} from '@kiln/core';

/**
 * The notes of a check, grouped for reading: one row per rule (and severity) with how many images it concerns and which ones, so
 * nineteen identical sentences become one line. Problems come before notes; inside a severity the biggest group first. Pure.
 * The rule code that means "the file could not be opened, so nothing was checked" is `UNREAD_RULE`: the screen words it itself.
 */
export const UNREAD_RULE = 'inspect.unread';

export type ProblemItem = {
  /** `locale/kind/device#position`, as `checkStoreImages` writes it. */
  path: string;
  /** A short name for a chip: `phone#1`, `Feature graphic#1`, with the locale in front when the groups span several. */
  chip: string;
  /** What was found for this image (the message without the documented rule), '' when nothing differs from the rule's text. */
  found: string;
};

export type ProblemGroup = {
  rule: string;
  severity: AssetSeverity;
  verified: boolean;
  source: string;
  /** The documented rule in words (the part of the message every image shares). */
  text: string;
  count: number;
  items: ProblemItem[];
};

const RANK: Record<AssetSeverity, number> = { error: 0, warning: 1, info: 2 };

/** The words two messages start with in common, cut back to the end of a sentence when there is one. */
export function commonText(messages: readonly string[]): string {
  const first = messages[0];
  if (first === undefined) return '';
  if (messages.length === 1) return first;
  const words = first.split(' ');
  let n = words.length;
  for (const m of messages.slice(1)) {
    const other = m.split(' ');
    let i = 0;
    while (i < n && i < other.length && words[i] === other[i]) i += 1;
    n = i;
  }
  const prefix = words.slice(0, n).join(' ');
  const cut = Math.max(
    prefix.lastIndexOf('. '),
    prefix.lastIndexOf('! '),
    prefix.lastIndexOf('? '),
  );
  if (cut > 0) return prefix.slice(0, cut + 1);
  if (/[.!?]$/.test(prefix)) return prefix;
  return messages.length > 0 && messages.every((m) => m === first)
    ? first
    : prefix.trim() === ''
      ? first
      : prefix.trim();
}

/** `locale/kind/device#position` into its parts, or null for a path of another shape. */
export function parsePath(
  path: string,
): { locale: string; kind: string; device: string; position: string } | null {
  const hash = path.lastIndexOf('#');
  if (hash < 0) return null;
  const parts = path.slice(0, hash).split('/');
  if (parts.length !== 3) return null;
  return {
    locale: parts[0] as string,
    kind: parts[1] as string,
    device: parts[2] as string,
    position: path.slice(hash + 1),
  };
}

export function chipOf(path: string, withLocale: boolean): string {
  const p = parsePath(path);
  if (!p) return path;
  const kind = (ASSET_KIND_LABELS as Record<string, string>)[p.kind] ?? p.kind;
  const slot = p.device === 'all' ? kind : p.device;
  return `${withLocale ? `${p.locale} ` : ''}${slot}#${p.position}`;
}

export function groupProblems(problems: readonly AssetProblem[]): ProblemGroup[] {
  const locales = new Set<string>();
  for (const p of problems) {
    const parsed = p.path ? parsePath(p.path) : null;
    if (parsed) locales.add(parsed.locale);
  }
  const withLocale = locales.size > 1;
  const byKey = new Map<string, AssetProblem[]>();
  for (const p of problems) {
    const key = `${p.rule}|${p.severity}`;
    const list = byKey.get(key);
    if (list) list.push(p);
    else byKey.set(key, [p]);
  }
  const groups: ProblemGroup[] = [];
  for (const list of byKey.values()) {
    const head = list[0] as AssetProblem;
    const text = commonText(list.map((p) => p.message));
    groups.push({
      rule: head.rule,
      severity: head.severity,
      verified: list.every((p) => p.verified),
      source: head.source,
      text,
      count: list.length,
      items: list.map((p) => ({
        path: p.path ?? '',
        chip: p.path ? chipOf(p.path, withLocale) : '',
        found:
          list.length > 1 && p.message.startsWith(text) ? p.message.slice(text.length).trim() : '',
      })),
    });
  }
  return groups.sort(
    (a, b) =>
      RANK[a.severity] - RANK[b.severity] || b.count - a.count || a.rule.localeCompare(b.rule),
  );
}

export type GroupedNotes = {
  /** Errors and warnings: what needs a look. */
  problems: ProblemGroup[];
  /** Notes (`info`) that are not the unread rule. */
  notes: ProblemGroup[];
  /** Images the checks could not open, as one group, or null. */
  unread: ProblemGroup | null;
  /** The number of images behind each part. */
  counts: { problems: number; notes: number; unread: number };
};

/** The groups split the way the Graphics tab shows them: problems, then notes, then the one line for what could not be checked. */
export function splitGroups(problems: readonly AssetProblem[]): GroupedNotes {
  const all = groupProblems(problems);
  const unread = all.find((g) => g.rule === UNREAD_RULE) ?? null;
  const rest = all.filter((g) => g.rule !== UNREAD_RULE);
  const sum = (list: ProblemGroup[]) => list.reduce((n, g) => n + g.count, 0);
  const problemGroups = rest.filter((g) => g.severity !== 'info');
  const notes = rest.filter((g) => g.severity === 'info');
  return {
    problems: problemGroups,
    notes,
    unread,
    counts: { problems: sum(problemGroups), notes: sum(notes), unread: unread?.count ?? 0 },
  };
}

export type { AssetKind };
