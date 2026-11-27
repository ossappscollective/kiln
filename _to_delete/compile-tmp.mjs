import { readFileSync } from 'node:fs';
import { compile, compileModule } from 'svelte/compiler';

const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  try {
    if (f.endsWith('.svelte.ts')) {
      const ts = (await import('node:module')).stripTypeScriptTypes;
      compileModule(ts(src), { filename: f });
    } else {
      compile(src, { filename: f, runes: true, generate: 'client' });
    }
    console.log('ok', f);
  } catch (e) {
    bad++;
    console.log('FAIL', f, e.message);
  }
}
process.exit(bad ? 1 : 0);
