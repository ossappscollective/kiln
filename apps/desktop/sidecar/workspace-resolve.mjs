// Module resolve hook for the packaged server. See launcher.mjs.
//
// Maps `@mrm/<name>` and `@mrm/<name>/<subpath>` to `<root>/packages/<name>/<exports target>`
// by reading that package's own `exports` map. Everything else resolves the normal way.
//
// The target files must stay outside any `node_modules` folder: Node refuses to strip types
// from TypeScript files found there.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PATTERN = /^@mrm\/([a-z0-9-]+)(\/.+)?$/;
let root = '';

export function initialize(data) {
  root = data.root;
}

export function resolve(specifier, context, nextResolve) {
  const match = PATTERN.exec(specifier);
  if (!match) return nextResolve(specifier, context);

  const [, name, rest] = match;
  const dir = join(root, 'packages', name);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`Packaged server is missing workspace package @mrm/${name}`);
  }
  const key = rest ? `.${rest}` : '.';
  const target = manifest.exports?.[key];
  if (typeof target !== 'string') {
    throw new Error(`@mrm/${name} does not export "${key}"`);
  }
  return nextResolve(pathToFileURL(join(dir, target)).href, context);
}
