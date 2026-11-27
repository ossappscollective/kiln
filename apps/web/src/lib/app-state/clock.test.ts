import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/**
 * The release surfaces take their time from the one clock helper (`useNow`): none keeps its own `Date.now()` in state or its own interval.
 * (The component guard, rule R2, fails a new one anywhere; this names the release folders so a regression says where to look.)
 */
const FOLDERS = ['release', 'testflight', 'builds', 'portfolio'];
/** Files of `portfolio/` that belong to the app-detail page (the state surfaces), not to the releases. */
const NOT_RELEASES = ['portfolio/AppDetail.svelte'];
const ROOT = new URL('../../components/', import.meta.url).pathname;

function svelteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...svelteFiles(path));
    else if (name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

test('the release surfaces keep no clock of their own', () => {
  const offenders: string[] = [];
  for (const folder of FOLDERS) {
    for (const file of svelteFiles(join(ROOT, folder))) {
      if (NOT_RELEASES.includes(file.slice(ROOT.length))) continue;
      const source = readFileSync(file, 'utf8');
      if (/\$state\(\s*Date\.now\(\)\s*\)|setInterval\(/.test(source))
        offenders.push(file.slice(ROOT.length));
    }
  }
  assert.deepEqual(offenders, []);
});
