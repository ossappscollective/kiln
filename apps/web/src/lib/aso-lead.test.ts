import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  competitorCounts,
  competitorsLead,
  fitLead,
  gapsLead,
  ideasLead,
  listingLead,
  marketsLead,
  searchTermsLead,
} from './aso-lead.ts';

const DAY = 86_400_000;

test('competitorCounts: a change counts for 7 days; not_found is counted apart', () => {
  const now = 100 * DAY;
  const c = competitorCounts(
    [
      { state: 'ok', latest: { kind: 'change', checkedAt: now - 2 * DAY } },
      { state: 'ok', latest: { kind: 'change', checkedAt: now - 9 * DAY } },
      { state: 'ok', latest: { kind: 'heartbeat', checkedAt: now - DAY } },
      { state: 'not_found', latest: null },
    ],
    now,
  );
  assert.deepEqual(c, { total: 4, changed: 1, notFound: 1 });
});

test('competitorsLead: changed first, then missing, then quiet; suggestions are one clause', () => {
  assert.equal(
    competitorsLead({ total: 0, changed: 0, notFound: 0, suggestions: 0 }).headline,
    'No competitors followed yet',
  );
  const changed = competitorsLead({ total: 5, changed: 3, notFound: 1, suggestions: 2 });
  assert.equal(changed.headline, '3 competitors changed recently');
  assert.match(changed.hint, /2 suggestions from your keywords are below/);
  assert.equal(
    competitorsLead({ total: 5, changed: 1, notFound: 0, suggestions: 0 }).headline,
    '1 competitor changed recently',
  );
  const gone = competitorsLead({ total: 2, changed: 0, notFound: 1, suggestions: 0 });
  assert.equal(gone.headline, '1 competitor is no longer in the store');
  assert.equal(gone.tone, 'warn');
  assert.equal(
    competitorsLead({ total: 2, changed: 0, notFound: 0, suggestions: 1 }).headline,
    'Following 2 competitors, none changed this week',
  );
});

test('ideasLead: counts over apps; the empty hint says what to do', () => {
  const some = ideasLead([
    { ideas: 4, competitors: 1, ownListing: true },
    { ideas: 2, competitors: 0, ownListing: true },
  ]);
  assert.equal(some.headline, '6 keyword ideas not tracked yet');
  assert.match(ideasLead([{ ideas: 0, competitors: 2, ownListing: false }]).hint, /Sync the app/);
  assert.match(
    ideasLead([{ ideas: 0, competitors: 0, ownListing: true }]).hint,
    /Follow a competitor/,
  );
  assert.match(ideasLead([{ ideas: 0, competitors: 2, ownListing: true }]).hint, /already tracked/);
});

test('gapsLead: no competitors, no gaps, some gaps', () => {
  assert.equal(gapsLead([{ gaps: 0, competitors: 0 }]).headline, 'No competitors to compare with');
  assert.equal(gapsLead([{ gaps: 0, competitors: 2 }]).tone, 'ok');
  assert.equal(
    gapsLead([{ gaps: 1, competitors: 2 }]).headline,
    '1 term competitors use that you do not',
  );
});

test('fitLead: missing is a warning, partial alone is info, all covered is ok', () => {
  assert.equal(fitLead([]).headline, 'No keywords to check yet');
  const miss = fitLead([{ keywords: 10, missing: 3, partial: 2 }]);
  assert.equal(miss.headline, '3 of 10 keywords are missing from the listing');
  assert.equal(miss.tone, 'warn');
  assert.match(miss.hint, /2 more are only partly covered/);
  assert.equal(
    fitLead([{ keywords: 1, missing: 1, partial: 0 }]).headline,
    '1 of 1 keyword is missing from the listing',
  );
  assert.equal(fitLead([{ keywords: 4, missing: 0, partial: 1 }]).tone, 'info');
  assert.equal(
    fitLead([{ keywords: 4, missing: 0, partial: 0 }]).headline,
    'The listing covers all 4 keywords',
  );
});

test('marketsLead: terms, countries and the ones that rank nowhere', () => {
  assert.equal(
    marketsLead({ terms: 0, countries: 0, unranked: 0 }).headline,
    'No keywords tracked yet',
  );
  assert.equal(
    marketsLead({ terms: 8, countries: 3, unranked: 2 }).headline,
    '8 keywords in 3 countries, 2 not ranked anywhere',
  );
  assert.equal(
    marketsLead({ terms: 1, countries: 1, unranked: 0 }).headline,
    '1 keyword in 1 country',
  );
  assert.match(marketsLead({ terms: 1, countries: 1, unranked: 0 }).hint, /second country/);
});

test('listingLead: loading, no text, untracked, all tracked', () => {
  assert.equal(
    listingLead({ loaded: false, localeRows: 0, untracked: 0 }).headline,
    'Keywords in your listing',
  );
  assert.equal(
    listingLead({ loaded: true, localeRows: 0, untracked: 0 }).headline,
    'No listing text is stored yet',
  );
  assert.equal(
    listingLead({ loaded: true, localeRows: 2, untracked: 5 }).headline,
    '5 terms in your listing are not tracked',
  );
  assert.equal(
    listingLead({ loaded: true, localeRows: 2, untracked: 1 }).headline,
    '1 term in your listing is not tracked',
  );
  assert.equal(listingLead({ loaded: true, localeRows: 2, untracked: 0 }).tone, 'ok');
});

test('searchTermsLead: nothing imported, an empty period, a file', () => {
  assert.equal(
    searchTermsLead([{ stored: false, terms: 0, period: null }]).headline,
    'No search terms imported yet',
  );
  assert.equal(
    searchTermsLead([{ stored: true, terms: 0, period: 'Jan' }]).headline,
    'No search terms in this period',
  );
  const s = searchTermsLead([{ stored: true, terms: 12, period: 'Oct 1 to Oct 28' }]);
  assert.equal(s.headline, '12 search terms from Google Play');
  assert.match(s.hint, /^Oct 1 to Oct 28\./);
});
