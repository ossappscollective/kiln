import { readFileSync } from 'node:fs';
import { compile, compileModule } from 'svelte/compiler';

let bad = 0;
for (const f of process.argv.slice(2)) {
  try {
    const src = readFileSync(f, 'utf8');
    if (f.endsWith('.svelte')) {
      const r = compile(src, { filename: f, generate: 'client', runes: true });
      for (const w of r.warnings) console.log('WARN', f, w.code, w.message.split('\n')[0]);
    } else {
      compileModule(src, { filename: f, generate: 'client' });
    }
    console.log('ok', f);
  } catch (e) {
    bad++;
    console.log('FAIL', f, e.message);
  }
}
process.exit(bad ? 1 : 0);
