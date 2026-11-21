import assert from 'node:assert/strict';
import { test } from 'node:test';
// The check lives in the repository's scripts folder so `pnpm i18n:check` and `pnpm test` run the same code.
import {
  canonicalText,
  checkCatalogs,
  checkUsage,
  namespaceOfSource,
  readCatalogFiles,
  runCheck,
  scanKeyUsage,
  scanLib,
  scanSvelte,
  stripComments,
} from '../../../../../scripts/i18n.mjs';

type Dict = Record<string, string>;
const file = (ns: string, lang: string, object: Dict, text?: string) => ({
  ns,
  lang,
  path: `apps/web/locales/${ns}/${lang}.json`,
  text: text ?? canonicalText(object),
});
const errorsOf = (files: ReturnType<typeof file>[]): string[] => checkCatalogs(files).errors;

test('the catalogs and every key used in the source pass the check', () => {
  const result = runCheck();
  assert.deepEqual(result.errors, [], `\n${result.errors.join('\n')}\nRun pnpm i18n:check, and pnpm i18n:fix for formatting.`);
});

test('every language has the pilot namespaces', () => {
  const files = readCatalogFiles();
  for (const ns of ['common', 'shell', 'auth']) {
    for (const lang of ['en', 'fr', 'es', 'de']) {
      assert.ok(files.some((f) => f.ns === ns && f.lang === lang), `${ns}/${lang}.json`);
    }
  }
});

test('files must be sorted, indented by two and end with a newline', () => {
  const object = { b: 'B', a: 'A' };
  assert.match(errorsOf([file('x', 'en', object, '{\n  "b": "B",\n  "a": "A"\n}\n')]).join('\n'), /not formatted/);
  assert.match(errorsOf([file('x', 'en', object, '{"a":"A","b":"B"}\n')]).join('\n'), /not formatted/);
  assert.match(errorsOf([file('x', 'en', object, '{\n  "a": "A",\n  "b": "B"\n}')]).join('\n'), /not formatted/);
  assert.deepEqual(errorsOf([file('x', 'en', object)]), []);
  assert.equal(canonicalText(object), '{\n  "a": "A",\n  "b": "B"\n}\n');
});

test('invalid JSON, nested objects, non-strings and bad key names are errors', () => {
  assert.match(errorsOf([file('x', 'en', {}, '{ nope')]).join('\n'), /not valid JSON/);
  assert.match(errorsOf([file('x', 'en', {}, '[]\n')]).join('\n'), /flat object/);
  assert.match(errorsOf([file('x', 'en', {}, '{\n  "a": { "b": "c" }\n}\n')]).join('\n'), /must be a string/);
  assert.match(errorsOf([file('x', 'en', { 'Bad Key': 'x' })]).join('\n'), /not a valid key/);
  assert.match(errorsOf([file('x', 'en', { 'a.1': 'x' })]).join('\n'), /not a valid key/);
  assert.match(errorsOf([file('x', 'en', { a: '' })]).join('\n'), /is empty/);
  assert.deepEqual(errorsOf([file('x', 'en', { 'card.title': 'T', 'delta.up_one': '1', 'delta.up_other': '2' })]), []);
});

test('a namespace needs English, and a language must be registered', () => {
  assert.match(errorsOf([file('x', 'fr', { a: 'A' })]).join('\n'), /has no en\.json/);
  assert.match(errorsOf([file('x', 'en', { a: 'A' }), file('x', 'tlh', { a: 'A' })]).join('\n'), /not registered/);
});

test('a translated key that English does not have is an orphan', () => {
  const errors = errorsOf([file('x', 'en', { a: 'A' }), file('x', 'fr', { a: 'A', gone: 'Parti' })]).join('\n');
  assert.match(errors, /"gone" does not exist in en\.json/);
});

test('placeholders must be the same set in every language', () => {
  const en = file('x', 'en', { hi: 'Hello {{name}}', two: '{{a}} of {{b}}' });
  assert.deepEqual(errorsOf([en, file('x', 'fr', { hi: 'Bonjour {{name}}', two: '{{b}} sur {{a}}' })]), []);
  assert.match(errorsOf([en, file('x', 'fr', { hi: 'Bonjour {{nom}}' })]).join('\n'), /missing \{\{name\}\}.*unknown \{\{nom\}\}/s);
  assert.match(errorsOf([en, file('x', 'fr', { hi: 'Bonjour' })]).join('\n'), /missing \{\{name\}\}/);
  assert.match(errorsOf([en, file('x', 'fr', { two: '{{a}} sur {{b}} {{c}}' })]).join('\n'), /unknown \{\{c\}\}/);
});

test('plural forms: English needs one and other; each language uses its own forms', () => {
  const plural = { n_one: '{{count}} item', n_other: '{{count}} items' };
  assert.deepEqual(errorsOf([file('x', 'en', plural)]), []);
  assert.match(errorsOf([file('x', 'en', { n_other: 'items' })]).join('\n'), /needs "n_one"/);
  assert.match(errorsOf([file('x', 'en', { ...plural, n_many: 'm' })]).join('\n'), /not a plural form of English/);
  // French: one, many, other. German: one, other.
  const fr = { n_one: '{{count}} élément', n_many: '{{count}} d’éléments', n_other: '{{count}} éléments' };
  assert.deepEqual(errorsOf([file('x', 'en', plural), file('x', 'fr', fr)]), []);
  assert.deepEqual(errorsOf([file('x', 'en', plural), file('x', 'es', fr)]), []);
  assert.deepEqual(errorsOf([file('x', 'en', plural), file('x', 'de', { n_one: '{{count}} Element', n_other: '{{count}} Elemente' })]), []);
  assert.match(errorsOf([file('x', 'en', plural), file('x', 'de', { ...fr })]).join('\n'), /"many" is not a plural form of de/);
  assert.match(errorsOf([file('x', 'en', plural), file('x', 'fr', { n_zero: 'z' })]).join('\n'), /"zero" is not a plural form of fr/);
  // The singular form may leave `count` out when English does.
  const spelled = { n_one: 'One item', n_other: '{{count}} items' };
  assert.deepEqual(errorsOf([file('x', 'en', spelled), file('x', 'de', { n_one: 'Ein Element', n_other: '{{count}} Elemente' })]), []);
  assert.match(errorsOf([file('x', 'en', plural), file('x', 'de', { n_one: 'Ein Element', n_other: '{{count}} Elemente' })]).join('\n'), /n_one.*missing \{\{count\}\}/);
  // Plural in one language, plain in another.
  assert.match(errorsOf([file('x', 'en', plural), file('x', 'fr', { n: 'x' })]).join('\n'), /is a plural in English/);
  assert.match(errorsOf([file('x', 'en', { a: 'A' }), file('x', 'fr', { a_one: 'x' })]).join('\n'), /not a plural in English/);
});

test('no HTML in messages: only the documented tags, closed, not nested, the same in every language', () => {
  const en = file('x', 'en', { help: 'Read <link>the guide</link>.', plain: 'Plain' });
  assert.deepEqual(errorsOf([en, file('x', 'fr', { help: 'Lisez <link>le guide</link>.' })]), []);
  assert.match(errorsOf([en, file('x', 'fr', { help: 'Lisez le guide.' })]).join('\n'), /missing <link>/);
  assert.match(errorsOf([en, file('x', 'fr', { help: 'Lisez <a href="x">le guide</a>.' })]).join('\n'), /HTML|not an allowed tag/);
  assert.match(errorsOf([file('x', 'en', { help: '<b>Bold</b>' })]).join('\n'), /not an allowed tag/);
  assert.match(errorsOf([file('x', 'en', { help: 'Read <link>the guide.' })]).join('\n'), /never closed/);
  assert.match(errorsOf([en, file('x', 'fr', { plain: 'Simple &amp; clair' })]).join('\n'), /entities/);
});

test('untranslated strings are coverage, never errors', () => {
  const result = checkCatalogs([
    file('x', 'en', { a: 'A', b: 'B', n_one: '1', n_other: 'n' }),
    file('x', 'fr', { a: 'À', b: '', n_one: '1' }),
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.coverage.fr?.missing, ['x:b', 'x:n_many', 'x:n_other']);
  assert.equal(result.coverage.fr?.translated, 2);
  assert.equal(result.coverage.fr?.total, 5);
  assert.deepEqual(result.coverage.de?.missing, ['x:a', 'x:b', 'x:n_one', 'x:n_other']);
  assert.equal(result.coverage.en?.translated, 4);
});

test('the scan finds t(), k() and <T key> with literal keys, comments excluded', () => {
  const usage = scanKeyUsage([
    {
      path: 'a.ts',
      text: [
        "const a = t('x:one');",
        "// t('x:commented')",
        "/* t('x:block') */",
        "const b = k(\"x:two\"); const c = t(`x:three`);",
        "const d = t('x:with.params', { count: 2 });",
        "const e = format('x:notacall'); const f = obj.t('x:method');",
      ].join('\n'),
    },
    {
      path: 'b.svelte',
      text: "<!-- t('x:html') -->\n<p>{t('x:four')}</p>\n<T key=\"x:five\" />\n<T\n  key={'x:six'}\n  tags={{}}\n/>\n",
    },
  ]);
  assert.deepEqual(
    usage.literals.map((l: { key: string }) => l.key),
    ['x:one', 'x:two', 'x:three', 'x:with.params', 'x:four', 'x:five', 'x:six'],
  );
  assert.deepEqual(usage.literals.map((l: { line: number }) => l.line), [1, 4, 4, 5, 2, 3, 4]);
});

test('keys built at run time are warnings; t(map[x]) is allowed', () => {
  const usage = scanKeyUsage([
    {
      path: 'a.ts',
      text: [
        'const a = t(`x:${name}`);',
        "const b = t('x:' + name);",
        'const c = t(labels[status]);',
        'const d = t(option.label);',
        'const e = t(cond ? a : b);',
        'const f = t(KEY, { n: 1 });',
        'const g = t();',
      ].join('\n'),
    },
    { path: 'b.svelte', text: '<T key={dynamic} />' },
  ]);
  assert.equal(usage.dynamic.length, 4);
  assert.equal(usage.indirect.length, 3);
  const english = checkCatalogs([file('x', 'en', { a: 'A' })]).english;
  assert.equal(checkUsage(usage, english).warnings.length, 4);
});

test('used keys must exist in English, plural bases count, tagged messages need <T>', () => {
  const english = checkCatalogs([
    file('x', 'en', { a: 'A', n_one: '1', n_other: 'n', rich: 'See <link>this</link>', unusedKey: 'U' }),
  ]).english;
  const use = (key: string, kind = 't') => ({ literals: [{ key, path: 'f.ts', line: 3, kind }], dynamic: [], indirect: [] });
  assert.deepEqual(checkUsage(use('x:a'), english).errors, []);
  assert.deepEqual(checkUsage(use('x:n'), english).errors, []);
  assert.match(checkUsage(use('x:missing'), english).errors.join(), /f\.ts:3: "x:missing" is not in locales\/x\/en\.json/);
  assert.match(checkUsage(use('nonamespace'), english).errors.join(), /no namespace/);
  assert.match(checkUsage(use('y:a'), english).errors.join(), /namespace "y"/);
  assert.match(checkUsage(use('x:rich'), english).errors.join(), /contains tags/);
  assert.deepEqual(checkUsage(use('x:rich', 'T'), english).errors, []);
  assert.deepEqual(checkUsage(use('x:a'), english).unused, ['x:n', 'x:rich', 'x:unusedKey']);
});

test('comments are blanked without moving lines', () => {
  const text = "a // c\nb /* x\ny */ c\nhttps://x.y // z\n";
  assert.equal(stripComments(text).split('\n').length, text.split('\n').length);
  assert.ok(stripComments(text).includes('https://x.y'));
  assert.ok(!stripComments(text).includes('c\n'.repeat(2)));
});

test('the hard-coded string scan reads text, attributes and literals, not code', () => {
  const items = scanSvelte(`<script lang="ts">
  let x = 'Not scanned here';
</script>
<h1>Settings</h1>
<button aria-label="Close dialog" class="ghost" title={open ? 'Hide it' : 'Show it'}>x</button>
<Card title="Reviews" collapseKey="reviews" count={3}>
  {#if ready}<p>{t('app:ok')}</p>{:else}<p>Loading…</p>{/if}
  <code>npm run build</code>
  <input placeholder="Search apps" id="q" />
  <span>{cond ? 'Open' : 'closed'}</span>
  <img src="/a.png" alt="" />
</Card>
<style>.a { content: 'Nope here'; }</style>`);
  assert.deepEqual(
    items.map((i: { text: string }) => i.text),
    ['Settings', 'aria-label: Close dialog', 'title: Hide it', 'title: Show it', 'title: Reviews', 'Loading…', 'placeholder: Search apps', 'Open'],
  );
});

test('the lib scan finds sentences and labels, not identifiers, imports or messages keys', () => {
  const items = scanLib(`import x from './a b.ts';
const a = 'Something went wrong. Try again.';
const b = 'ios';
const c = \`Saved \${n} items\`;
const d = 'ns:some.key';
// 'A comment with words'
throw new Error('Not user facing at all');`);
  assert.deepEqual(items.map((i: { text: string }) => i.text), ['Something went wrong. Try again.', 'Saved   items']);
});

test('areas map to namespaces', () => {
  assert.equal(namespaceOfSource('apps/web/src/components/Shell.svelte'), 'shell');
  assert.equal(namespaceOfSource('apps/web/src/components/ui/Button.svelte'), 'common');
  assert.equal(namespaceOfSource('apps/web/src/components/revenuecat/RevenueCatCell.svelte'), 'products');
  assert.equal(namespaceOfSource('apps/web/src/components/publish/PublishDialog.svelte'), 'publish');
  assert.equal(namespaceOfSource('apps/web/src/lib/app-nav.ts'), 'app');
  assert.equal(namespaceOfSource('apps/web/src/lib/analytics/analytics.ts'), 'analytics');
  assert.equal(namespaceOfSource('apps/web/src/lib/release-notes.ts'), 'release');
  assert.equal(namespaceOfSource('apps/web/src/lib/staged.ts'), 'publish');
  assert.equal(namespaceOfSource('apps/web/src/lib/api.ts'), 'common');
});
