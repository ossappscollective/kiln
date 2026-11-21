/**
 * The demo workspace (`pnpm demo`, docs/demo.md). The demo server answers `GET /demo/status` with `{ "demo": true, ... }`; any other
 * server has no such route (404, or the web app's own page). The shell shows a slim, permanent bar when the answer says demo.
 */

import { k } from './i18n/t.ts';

/** Whether an answer of `GET /demo/status` says this is the demo workspace. Anything else (HTML, an error body, nothing) is not demo. */
export function isDemoStatus(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as Record<string, unknown>).demo === true
  );
}

/** The message key of the sentence of the bar (translate it with `t()` where it is drawn). */
export const DEMO_BANNER_KEY = k('shell:demo.banner');
