import { isAbsolute } from 'node:path';

/**
 * The folder the web UI is served from, in the form `serveStatic` expects: absolute paths and
 * paths that already start with a dot are kept, anything else is made relative to the working
 * directory. The check must be the platform's own: a Windows path such as `D:\a\web` does not start
 * with `/` or `.`, and turning it into `./D:\a\web` made every page answer 404.
 */
export function webRoot(webDist: string): string {
  return isAbsolute(webDist) || webDist.startsWith('.') ? webDist : `./${webDist}`;
}
