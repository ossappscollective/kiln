import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type Catalog,
  interpolate,
  PSEUDO_LOCALE,
  pickMessage,
  placeholdersOf,
  pluralCategories,
  pluralCategory,
  pseudoize,
  splitKey,
  splitPluralKey,
  splitRich,
  tagProblem,
  tokensOf,
  translate,
  translateParts,
} from './core.ts';

const catalogs: Record<string, Record<string, Catalog>> = {
  en: {
    app: {
      hello: 'Hello {{name}}',
      items_one: '{{count}} item',
      items_other: '{{count}} items',
      onlyEnglish: 'Only in English',
      help: 'Read <link>the guide</link> first, <strong>{{name}}</strong>.',
    },
  },
  fr: {
    app: {
      hello: 'Bonjour {{name}}',
      items_one: '{{count}} élément',
      items_many: '{{count}} d’éléments',
      items_other: '{{count}} éléments',
      empty: '',
    },
  },
  de: {
    app: {
      hello: 'Hallo {{name}}',
      items_one: '{{count}} Element',
      items_other: '{{count}} Elemente',
    },
  },
};
const lookup = (locale: string, ns: string) => catalogs[locale]?.[ns];
const missed: string[] = [];
const tr = (locale: string, key: string, params?: Record<string, string | number>) =>
  translate(key, params, { locale, lookup, onMissing: (k) => missed.push(k) });

test('keys split at the first colon', () => {
  assert.deepEqual(splitKey('shell:nav.allApps'), { ns: 'shell', key: 'nav.allApps' });
  assert.equal(splitKey('nav.allApps'), null);
  assert.equal(splitKey(':x'), null);
  assert.equal(splitKey('x:'), null);
  assert.deepEqual(splitPluralKey('delta.up_one'), { base: 'delta.up', category: 'one' });
  assert.deepEqual(splitPluralKey('delta.up'), { base: 'delta.up', category: null });
  assert.deepEqual(splitPluralKey('a_b'), { base: 'a_b', category: null });
});

test('plural categories follow CLDR for each target language', () => {
  assert.deepEqual([...pluralCategories('en')].sort(), ['one', 'other']);
  assert.deepEqual([...pluralCategories('de')].sort(), ['one', 'other']);
  assert.deepEqual([...pluralCategories('fr')].sort(), ['many', 'one', 'other']);
  assert.deepEqual([...pluralCategories('es')].sort(), ['many', 'one', 'other']);
  assert.deepEqual([...pluralCategories('pseudo')].sort(), ['one', 'other']);
  assert.deepEqual(pluralCategories('not a locale!'), ['other']);
});

test('plural selection per language', () => {
  assert.equal(pluralCategory('en', 1), 'one');
  assert.equal(pluralCategory('en', 0), 'other');
  assert.equal(pluralCategory('en', 2), 'other');
  // French treats 0 and 1 as singular and whole millions as "many".
  assert.equal(pluralCategory('fr', 0), 'one');
  assert.equal(pluralCategory('fr', 1), 'one');
  assert.equal(pluralCategory('fr', 2), 'other');
  assert.equal(pluralCategory('fr', 1_000_000), 'many');
  assert.equal(pluralCategory('es', 1), 'one');
  assert.equal(pluralCategory('es', 0), 'other');
  assert.equal(pluralCategory('es', 1_000_000), 'many');
  assert.equal(pluralCategory('de', 1), 'one');
  assert.equal(pluralCategory('de', 0), 'other');
});

test('interpolation fills {{name}}, tolerates spaces, leaves missing values visible', () => {
  assert.equal(interpolate('Hi {{name}}', { name: 'Ada' }, 'en'), 'Hi Ada');
  assert.equal(interpolate('Hi {{ name }}!', { name: 'Ada' }, 'en'), 'Hi Ada!');
  assert.equal(interpolate('Hi {{name}}', {}, 'en'), 'Hi {{name}}');
  assert.equal(interpolate('Hi {{name}}', undefined, 'en'), 'Hi {{name}}');
  assert.equal(interpolate('Hi {{name}}', { name: null }, 'en'), 'Hi ');
  assert.equal(interpolate('{{a}} and {{a}}', { a: 1 }, 'en'), '1 and 1');
  assert.equal(interpolate('{{n}}', { n: 0 }, 'en'), '0');
});

test('a value is never interpolated again, and `count` uses the language grouping', () => {
  assert.equal(interpolate('{{a}} {{b}}', { a: '{{b}}', b: 'x' }, 'en'), '{{b}} x');
  assert.equal(interpolate('{{count}}', { count: 1234567 }, 'en'), '1,234,567');
  assert.equal(interpolate('{{count}}', { count: 1234567 }, 'de'), '1.234.567');
  assert.equal(interpolate('{{other}}', { other: 1234567 }, 'de'), '1234567');
});

test('translate: active language, then English, then the key', () => {
  missed.length = 0;
  assert.equal(tr('fr', 'app:hello', { name: 'Ada' }), 'Bonjour Ada');
  assert.equal(tr('fr', 'app:onlyEnglish'), 'Only in English');
  assert.equal(tr('de', 'app:onlyEnglish'), 'Only in English');
  assert.deepEqual(missed, []);
  assert.equal(tr('fr', 'app:nothing'), 'app:nothing');
  assert.equal(tr('fr', 'nope'), 'nope');
  assert.equal(tr('xx', 'app:hello', { name: 'A' }), 'Hello A');
  assert.deepEqual(missed, ['app:nothing', 'nope']);
});

test('an empty string is an untranslated string (Weblate writes those) and falls back', () => {
  assert.equal(pickMessage({ a: '' }, 'a', 'fr', undefined), undefined);
  assert.equal(tr('fr', 'app:empty'), 'app:empty');
});

test('translate: plural forms by count', () => {
  assert.equal(tr('en', 'app:items', { count: 1 }), '1 item');
  assert.equal(tr('en', 'app:items', { count: 5 }), '5 items');
  assert.equal(tr('en', 'app:items', { count: 0 }), '0 items');
  assert.equal(tr('fr', 'app:items', { count: 0 }), '0 élément');
  assert.equal(tr('fr', 'app:items', { count: 3 }), '3 éléments');
  assert.equal(tr('fr', 'app:items', { count: 1_000_000 }), '1 000 000 d’éléments');
  assert.equal(tr('de', 'app:items', { count: 1 }), '1 Element');
  assert.equal(tr('de', 'app:items', { count: 2 }), '2 Elemente');
});

test('a plural category the language lacks falls back to _other', () => {
  assert.equal(tr('de', 'app:items', { count: 1_000_000 }), '1.000.000 Elemente');
  assert.equal(tr('fr', 'app:hello', { name: 'Ada', count: 3 }), 'Bonjour Ada');
  assert.equal(tr('en', 'app:items'), '{{count}} items');
});

test('a plural key missing in the language is read from English with English rules', () => {
  const partial: Record<string, Record<string, Catalog>> = {
    en: catalogs.en as Record<string, Catalog>,
    fr: { app: {} },
  };
  const out = translate(
    'app:items',
    { count: 1 },
    { locale: 'fr', lookup: (l, n) => partial[l]?.[n] },
  );
  assert.equal(out, '1 item');
});

test('the pseudo-locale transforms English, keeps placeholders, counts and tags', () => {
  assert.match(tr(PSEUDO_LOCALE, 'app:hello', { name: 'Ada' }), /^\[.+ Ada ~+\]$/);
  assert.equal(
    tr(PSEUDO_LOCALE, 'app:items', { count: 1 }),
    pseudoize('{{count}} item').replace('{{count}}', '1'),
  );
  const long = pseudoize('Save changes');
  assert.ok(long.startsWith('[') && long.endsWith(']'));
  assert.ok(long.length >= 'Save changes'.length * 1.3);
  assert.ok(!/[a-zA-Z]/.test(long.replace(/~/g, '')), 'every letter is accented');
  assert.match(pseudoize('<link>Go</link> {{n}}'), /^\[<link>.+<\/link> \{\{n\}\} ~\]$/);
});

test('placeholders and tokens', () => {
  assert.deepEqual(placeholdersOf('{{b}} {{a}} {{ b }}'), ['a', 'b']);
  assert.deepEqual(tokensOf('Read <link>this</link> {{name}}'), ['<link>', '{{name}}']);
  assert.deepEqual(tokensOf('Plain'), []);
});

test('rich text splits into parts and never into HTML', () => {
  assert.deepEqual(splitRich('Plain'), [{ text: 'Plain' }]);
  assert.deepEqual(splitRich(''), [{ text: '' }]);
  assert.deepEqual(splitRich('Read <link>the guide</link> first.'), [
    { text: 'Read ' },
    { tag: 'link', text: 'the guide' },
    { text: ' first.' },
  ]);
  assert.deepEqual(splitRich('<strong>Bold</strong><em>It</em>'), [
    { tag: 'strong', text: 'Bold' },
    { tag: 'em', text: 'It' },
  ]);
  // Unknown tags, an unclosed tag and a lone "<" stay text.
  assert.deepEqual(splitRich('a <b>x</b>'), [{ text: 'a <b>x</b>' }]);
  assert.deepEqual(splitRich('a <link>x'), [{ text: 'a <link>x' }]);
  assert.deepEqual(splitRich('1 < 2 <link>x</link>'), [
    { text: '1 < 2 ' },
    { tag: 'link', text: 'x' },
  ]);
});

test('translateParts puts values in after the tags are found: a value cannot add a tag', () => {
  const parts = translateParts('app:help', { name: '<link>evil</link>' }, { locale: 'en', lookup });
  assert.deepEqual(parts, [
    { text: 'Read ' },
    { tag: 'link', text: 'the guide' },
    { text: ' first, ' },
    { tag: 'strong', text: '<link>evil</link>' },
    { text: '.' },
  ]);
  assert.deepEqual(translateParts('app:nope', undefined, { locale: 'en', lookup }), [
    { text: 'app:nope' },
  ]);
});

test('tagProblem accepts the documented tags and rejects the rest', () => {
  assert.equal(tagProblem('Plain {{x}} text'), '');
  assert.equal(tagProblem('a <link>b</link> c <strong>d</strong>'), '');
  assert.equal(tagProblem('1 < 2 and 3 > 2'), '');
  assert.match(tagProblem('<b>x</b>'), /not an allowed tag/);
  assert.match(tagProblem('<link>x'), /never closed/);
  assert.match(tagProblem('x</link>'), /no opening tag/);
  assert.match(tagProblem('<link>a <em>b</em></link>'), /do not nest/);
  assert.match(tagProblem('<link>a</em>'), /closes <link>/);
  assert.match(tagProblem('<div class="x">'), /HTML/);
  assert.match(tagProblem('Fish &amp; chips'), /entities/);
  assert.match(tagProblem('<Link>x</Link>'), /HTML/);
});
