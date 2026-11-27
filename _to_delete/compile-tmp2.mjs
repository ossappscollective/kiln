import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';

for (const f of process.argv.slice(2)) {
  try {
    const src = readFileSync(f, 'utf8');
    // strip lang="ts" script types is not possible here: use preprocess
    const { preprocess } = await import('svelte/compiler');
    const out = await preprocess(
      src,
      {
        script: ({ content, attributes }) => {
          return undefined;
        },
      },
      { filename: f },
    );
    compile(out.code, { filename: f, runes: true, generate: 'client' });
    console.log('ok', f);
  } catch (e) {
    console.log('FAIL', f, e.message);
  }
}
