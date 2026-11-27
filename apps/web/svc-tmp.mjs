import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

let bad = 0;
for (const f of process.argv.slice(2)) {
  try {
    compile(readFileSync(f, 'utf8'), { filename: f, runes: true, generate: 'client' });
    console.log('ok', f);
  } catch (e) {
    bad++;
    console.log('FAIL', f, e.message);
  }
}
process.exit(bad ? 1 : 0);
