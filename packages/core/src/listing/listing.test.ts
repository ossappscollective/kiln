import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  countBytes,
  countCharacters,
  type Listing,
  listingIsValid,
  validateListing,
} from './listing.ts';

const goodApple = {
  name: 'Trail Notes',
  subtitle: 'Hike, log, share',
  description: 'Log every hike and share it with friends.',
  keywords: 'hiking,trail,gps,journal',
  promotional_text: 'New trails every week.',
  support_url: 'https://example.com/support',
  privacy_url: 'https://example.com/privacy',
};

const goodPlay = {
  title: 'Trail Notes',
  short_description: 'Log every hike.',
  full_description: 'Log every hike and share it with friends.',
};

const find = (problems: ReturnType<typeof validateListing>, field: string, code: string) =>
  problems.find((p) => p.field === field && p.code === code);

test('a complete listing has no problems', () => {
  const listing: Listing = {
    appStore: { locales: { 'en-US': goodApple }, copyright: '2026 Example, Inc.' },
    googlePlay: { locales: { 'en-US': goodPlay }, changelogs: { 'en-US': { '42': 'Fixes.' } } },
  };
  assert.deepEqual(validateListing(listing), []);
});

test('counts code points for characters and UTF-8 for bytes', () => {
  assert.equal(countCharacters('a😀b'), 3);
  assert.equal(countBytes('a😀b'), 6);
  assert.equal(countBytes('é'), 2);
});

test('App Store limits: name 30, subtitle 30, promo 170, description 4000, release notes 4000', () => {
  const listing: Listing = {
    appStore: {
      copyright: '2026 Example',
      locales: {
        'en-US': {
          ...goodApple,
          name: 'x'.repeat(31),
          subtitle: 'x'.repeat(31),
          promotional_text: 'x'.repeat(171),
          description: 'x'.repeat(4001),
          release_notes: 'x'.repeat(4001),
        },
      },
    },
  };
  const problems = validateListing(listing);
  for (const field of ['name', 'subtitle', 'promotional_text', 'description', 'release_notes']) {
    const p = find(problems, field, 'too_long');
    assert.ok(p, `${field} should be too long`);
    assert.equal(p.severity, 'error');
  }
  assert.equal(find(problems, 'name', 'too_long')?.limit, 30);
  assert.equal(find(problems, 'name', 'too_long')?.actual, 31);
});

test('limits are inclusive', () => {
  const listing: Listing = {
    appStore: {
      copyright: '2026 Example',
      locales: {
        'en-US': { ...goodApple, name: 'x'.repeat(30), promotional_text: 'x'.repeat(170) },
      },
    },
  };
  assert.deepEqual(validateListing(listing), []);
});

test('keywords are limited in bytes, not characters', () => {
  // 15 words of three two-byte characters: 59 characters, but 104 bytes with commas.
  const keywords = Array.from({ length: 15 }, () => 'ééé').join(',');
  const listing: Listing = {
    appStore: { copyright: 'c', locales: { 'en-US': { ...goodApple, keywords } } },
  };
  const p = find(validateListing(listing), 'keywords', 'too_long');
  assert.ok(p);
  assert.equal(p.unit, 'bytes');
  assert.equal(p.actual, 15 * 6 + 14);
  assert.equal(p.limit, 100);
});

test('keyword advice is only a warning', () => {
  const listing: Listing = {
    appStore: {
      copyright: 'c',
      locales: { 'en-US': { ...goodApple, keywords: 'hiking,Hiking,,ab,trail\n' } },
    },
  };
  const problems = validateListing(listing);
  for (const code of [
    'keywords_duplicate',
    'keywords_empty_entry',
    'keywords_short_entry',
    'keywords_newline',
  ]) {
    const p = find(problems, 'keywords', code);
    assert.ok(p, code);
    assert.equal(p.severity, 'warning');
  }
  assert.equal(listingIsValid(problems), true);
});

test('missing required fields are reported per locale', () => {
  const listing: Listing = {
    appStore: { locales: { 'en-US': { name: 'Trail Notes' }, de: { ...goodApple } } },
  };
  const problems = validateListing(listing);
  const missing = problems.filter((p) => p.code === 'missing_required' && p.locale === 'en-US');
  assert.deepEqual(missing.map((p) => p.field).sort(), [
    'description',
    'keywords',
    'privacy_url',
    'support_url',
  ]);
  // Required and confirmed by Apple, so an error.
  assert.equal(find(problems, 'keywords', 'missing_required')?.severity, 'error');
  // copyright is not per locale.
  const copyright = problems.find((p) => p.field === 'copyright');
  assert.equal(copyright?.locale, undefined);
  assert.equal(copyright?.code, 'missing_required');
});

test('a whitespace-only required field counts as missing', () => {
  const listing: Listing = {
    appStore: { copyright: 'c', locales: { 'en-US': { ...goodApple, description: '  \n' } } },
  };
  assert.ok(find(validateListing(listing), 'description', 'missing_required'));
});

test('the default folder fills gaps in other locales and is not itself required to be complete', () => {
  const listing: Listing = {
    appStore: {
      copyright: 'c',
      locales: {
        default: {
          support_url: 'https://example.com/support',
          privacy_url: 'https://example.com/privacy',
        },
        'en-US': {
          name: 'Trail Notes',
          description: 'Log every hike and share it.',
          keywords: 'hiking,trail',
        },
      },
    },
  };
  assert.deepEqual(validateListing(listing), []);
});

test('unverified rules produce warnings, not errors', () => {
  const listing: Listing = {
    appStore: {
      copyright: 'c',
      locales: {
        'en-US': {
          ...goodApple,
          description: 'short',
          support_url: `https://example.com/${'x'.repeat(260)}`,
        },
        fr: { name: 'Trail Notes' },
      },
    },
  };
  const problems = validateListing(listing);
  assert.equal(find(problems, 'description', 'too_short')?.severity, 'warning');
  assert.equal(find(problems, 'support_url', 'too_long')?.severity, 'warning');
});

test('name has a verified minimum of two characters', () => {
  const listing: Listing = {
    appStore: { copyright: 'c', locales: { 'en-US': { ...goodApple, name: 'A' } } },
  };
  const p = find(validateListing(listing), 'name', 'too_short');
  assert.equal(p?.severity, 'error');
  assert.equal(p?.limit, 2);
});

test('URLs need a protocol', () => {
  const listing: Listing = {
    appStore: {
      copyright: 'c',
      locales: { 'en-US': { ...goodApple, marketing_url: 'example.com' } },
    },
  };
  assert.ok(find(validateListing(listing), 'marketing_url', 'invalid_url'));
});

test('Play limits: title 30, short 80, full 4000, changelog 500', () => {
  const listing: Listing = {
    googlePlay: {
      locales: {
        'en-US': {
          title: 'x'.repeat(31),
          short_description: 'x'.repeat(81),
          full_description: 'x'.repeat(4001),
        },
      },
      changelogs: { 'en-US': { '42': 'x'.repeat(501), default: 'ok' } },
    },
  };
  const problems = validateListing(listing);
  assert.equal(find(problems, 'title', 'too_long')?.limit, 30);
  assert.equal(find(problems, 'short_description', 'too_long')?.limit, 80);
  assert.equal(find(problems, 'full_description', 'too_long')?.limit, 4000);
  const changelog = find(problems, 'changelog/42', 'too_long');
  assert.equal(changelog?.limit, 500);
  assert.equal(changelog?.severity, 'error');
  assert.equal(find(problems, 'changelog/default', 'too_long'), undefined);
});

test('Play required fields are warnings until Google confirms them', () => {
  const listing: Listing = { googlePlay: { locales: { 'en-US': {} }, changelogs: {} } };
  const problems = validateListing(listing);
  assert.equal(problems.filter((p) => p.code === 'missing_required').length, 3);
  assert.ok(listingIsValid(problems));
});

test('Play video should be a YouTube URL', () => {
  const play = (video: string): Listing => ({
    googlePlay: { locales: { 'en-US': { ...goodPlay, video } }, changelogs: {} },
  });
  assert.deepEqual(validateListing(play('https://www.youtube.com/watch?v=abc')), []);
  assert.deepEqual(validateListing(play('https://youtu.be/abc')), []);
  assert.equal(
    find(validateListing(play('https://vimeo.com/1')), 'video', 'invalid_url')?.severity,
    'warning',
  );
  assert.equal(
    find(validateListing(play('youtube.com/x')), 'video', 'invalid_url')?.severity,
    'error',
  );
});
