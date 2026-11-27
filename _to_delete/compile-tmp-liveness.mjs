import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, 'utf8');
  try {
    const r = compile(src.replace(/<script lang="ts">/, '<script lang="ts">'), {
      generate: 'client',
      runes: true,
      filename: f,
    });
    console.log(
      'ok',
      f,
      r.warnings.length ? `warnings: ${r.warnings.map((w) => w.code).join(',')}` : '',
    );
  } catch (e) {
    console.log('FAIL', f, e.message);
  }
}
