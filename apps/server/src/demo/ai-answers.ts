import type { AiCompleteRequest, FakeAnswer } from '@kiln/connectors';

export type AiAnswerLike = FakeAnswer;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** The enum of `properties.<a>.items.properties.<b>`, from a JSON schema. */
function enumOf(schema: unknown, a: string, b: string): string[] {
  const items = obj(obj(obj(schema).properties)[a]).items;
  const e = obj(obj(obj(items).properties)[b]).enum;
  return arr(e).filter((x): x is string => typeof x === 'string');
}

const KEYWORD_IDEAS: { term: string; reason: string }[] = [
  {
    term: 'quick notes',
    reason: 'People look for a fast way to jot something down; it matches what the app does best.',
  },
  {
    term: 'offline notes',
    reason: 'The app works offline, and few results say so in their listing.',
  },
  {
    term: 'shared checklist',
    reason: 'Shared folders are new in this version and the phrase has little competition.',
  },
  { term: 'note sync', reason: 'Sync is the main reason people switch notes apps.' },
  {
    term: 'daily journal',
    reason: 'A neighbouring use case that the description already supports.',
  },
  {
    term: 'rain alert',
    reason: 'The headline feature of the weather app, searched by people who want a warning.',
  },
  { term: 'hourly forecast', reason: 'A common term the listing does not mention yet.' },
];

/**
 * The demo's built-in "model": deterministic answers for the three tasks, shaped by each task's own JSON schema. It runs
 * through the same validation as a real provider, so the accept and reject paths behave the same.
 */
export function aiAnswer(request: AiCompleteRequest): FakeAnswer {
  const usage = { inputTokens: 640, outputTokens: 180 };
  const name = request.schemaName ?? '';
  const schema = request.schema as unknown;
  if (name === 'keyword_ideas') {
    const fields = enumOf(schema, 'ideas', 'field');
    const real = fields.filter((f) => f !== 'track_only');
    return {
      output: {
        ideas: KEYWORD_IDEAS.slice(0, 5).map((idea, i) => ({
          term: idea.term,
          reason: idea.reason,
          field:
            i === 4
              ? fields.includes('track_only')
                ? 'track_only'
                : (real[0] ?? fields[0])
              : (real[i % Math.max(1, real.length)] ?? fields[0]),
        })),
      },
      usage,
      model: 'demo-model',
    };
  }
  if (name === 'listing_improve') {
    const input = obj(request.input);
    const facts = arr(input.fields).map(obj);
    const wanted = enumOf(schema, 'fields', 'field');
    const out = wanted.map((field) => {
      const fact = facts.find((f) => f.field === field);
      const current = typeof fact?.current === 'string' ? fact.current : '';
      const limit = typeof fact?.limit === 'number' ? fact.limit : 4000;
      let text: string;
      if (field === 'keywords') {
        const entries = current
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const extra of ['quick notes', 'offline', 'shared'])
          if (!entries.includes(extra)) entries.push(extra);
        text = entries.join(',');
        while (text.length > limit && entries.length > 1) {
          entries.pop();
          text = entries.join(',');
        }
      } else if (field === 'promotional_text' || field === 'short_description') {
        text = current
          ? `${current.replace(/[.!]+$/, '')}. Try it free today.`
          : 'Try it free today.';
      } else {
        text = current
          ? `${current}\n\nNew: everything stays in sync, even when you are offline.`
          : 'A calm, fast app that keeps everything in sync, even when you are offline.';
      }
      if (text.length > limit) text = text.slice(0, limit);
      return {
        field,
        text,
        reason:
          field === 'keywords'
            ? 'Adds three terms people search for that the list does not have.'
            : 'Leads with the benefit and adds a short, true call to action.',
      };
    });
    return { output: { fields: out.slice(0, 3) }, usage, model: 'demo-model' };
  }
  if (name === 'review_reply_draft') {
    const input = obj(request.input);
    const review = obj(input.review);
    const rating = typeof review.rating === 'number' ? review.rating : 3;
    const text =
      rating >= 4
        ? 'Thank you for the kind words. It means a lot to the whole team, and we have more improvements on the way.'
        : 'Thank you for telling us, and we are sorry for the trouble. We are looking into it now. If you can, write to support@demo.example.com with your device model so we can help you directly.';
    return { output: { reply: text }, usage, model: 'demo-model' };
  }
  if (name === 'release_notes_translate') {
    // The demo "translates" by marking the text with the language: there is no model, and the texts say so.
    const input = obj(request.input);
    const limit = typeof input.limit === 'number' ? input.limit : 500;
    const text = typeof input.text === 'string' ? input.text : '';
    return {
      output: {
        translations: arr(input.targets)
          .filter((t): t is string => typeof t === 'string')
          .map((locale) => ({ locale, text: `[Demo ${locale}] ${text}`.slice(0, limit) })),
      },
      usage,
      model: 'demo-model',
    };
  }
  // The connection test and anything else: a short valid object.
  return { output: {}, usage, model: 'demo-model' };
}
