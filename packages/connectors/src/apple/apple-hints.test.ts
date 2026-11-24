import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsoError } from '../aso-common.ts';
import {
  appleHintsUrl,
  appleStorefrontId,
  fetchAppleHints,
  parseAppleHints,
} from './apple-hints.ts';

// Hand written: the shape is what the service is widely observed to send, not a recorded answer.
const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>hints</key><array>
<dict><key>term</key><string>Water Reminder</string></dict>
<dict><key>term</key><string>water  tracker &amp; log</string></dict>
<dict><key>term</key><string>water reminder</string></dict>
<dict><key>other</key><string>x</string></dict>
</array></dict></plist>`;

test('parses terms: lower case, decoded, once, in order; none is an empty list', () => {
  assert.deepEqual(parseAppleHints(PLIST), ['water reminder', 'water tracker & log']);
  assert.deepEqual(parseAppleHints('<plist><dict></dict></plist>'), []);
  assert.deepEqual(parseAppleHints('not xml'), []);
});

test('url encodes the term; storefronts are known or absent', () => {
  assert.equal(
    appleHintsUrl('a b&c'),
    'https://search.itunes.apple.com/WebObjects/MZSearchHints.woa/wa/hints?clientApplication=Software&term=a%20b%26c',
  );
  assert.equal(appleStorefrontId('DE'), 143443);
  assert.equal(appleStorefrontId('zz'), undefined);
});

test('fetch sends the storefront header, never a cookie, and maps limits and an unknown storefront', async () => {
  let seen: { url: string; headers: Record<string, string> } | undefined;
  const ok: typeof fetch = async (url, init) => {
    seen = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(PLIST, { status: 200 });
  };
  assert.deepEqual(await fetchAppleHints({ term: 'water', country: 'us', fetch: ok }), [
    'water reminder',
    'water tracker & log',
  ]);
  assert.equal(seen?.headers['x-apple-store-front'], '143441-1,29');
  assert.equal(seen?.headers.cookie, undefined);
  await assert.rejects(
    fetchAppleHints({ term: 'x', country: 'zz', fetch: ok }),
    (e: unknown) => e instanceof AsoError && e.kind === 'invalid_input',
  );
  const slow: typeof fetch = async () =>
    new Response(null, { status: 429, headers: { 'retry-after': '30' } });
  await assert.rejects(
    fetchAppleHints({ term: 'x', country: 'us', fetch: slow }),
    (e: unknown) =>
      e instanceof AsoError && e.kind === 'rate_limited' && e.retryAfterSeconds === 30,
  );
});
