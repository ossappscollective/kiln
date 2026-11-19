/**
 * The demo workspace (`pnpm demo`, docs/demo.md). The demo server answers `GET /demo/status` with `{ "demo": true, ... }`; any other
 * server has no such route (404, or the web app's own page). The shell shows a slim, permanent bar when the answer says demo.
 */

/** Whether an answer of `GET /demo/status` says this is the demo workspace. Anything else (HTML, an error body, nothing) is not demo. */
export function isDemoStatus(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && (value as Record<string, unknown>).demo === true
  );
}

/** The sentence of the bar. */
export const DEMO_BANNER_TEXT = 'Demo workspace — simulated stores, nothing leaves your machine';
