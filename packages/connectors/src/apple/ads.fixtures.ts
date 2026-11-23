/**
 * Hand-written answers of the Apple Ads Platform API v1, copied in shape from Apple's documentation (Implementing OAuth, Managing Ad
 * Accounts and API Access, Managing Reports, Search Terms Report, Campaigns Report, Search Term Popularity Query). No real account
 * was called; names and ids are made up.
 */
export const ADS_TOKEN = { access_token: 'access-token-1', token_type: 'Bearer', expires_in: 3600, scope: 'searchadsorg' };

export const ADS_ACLS = {
  result: {
    acls: [
      { adAccount: { id: 123456789, name: 'AwayFinder', orgId: 27154130 }, roles: ['API Account Read Only'] },
      { adAccount: { id: 987654321, name: 'Second account', orgId: 27154130 }, roles: ['Limited Access: API Read Only'] },
    ],
  },
};

export const ADS_ACCOUNT = {
  result: {
    id: 123456789,
    name: 'AwayFinder Ad Account',
    orgId: 27154130,
    timezone: 'America/New_York',
    currency: 'EUR',
    paymentModel: 'PAYG',
    systemStatus: 'ACTIVE',
    productFeatures: ['APPSTORE_APP_MANUAL'],
  },
};

const money = (amount: string) => ({ amount, currency: 'EUR' });

export const ADS_CAMPAIGN_REPORT = {
  result: {
    rows: [
      {
        metadata: { id: 444555666, name: 'AwayFinder US', adAccountId: 123456789, promotedObjectType: 'APPSTORE_APP', promotedObjectId: '987654321', status: 'ENABLED', deleted: false },
        totalMetrics: { localSpend: money('30.50'), impressions: 3000, taps: 150, tapInstalls: 35, totalInstalls: 42 },
        granularMetrics: [
          { date: '2026-11-01', localSpend: money('10.25'), impressions: 1000, taps: 50, tapInstalls: 10, totalInstalls: 12 },
          { date: '2026-11-02', localSpend: money('20.25'), impressions: 2000, taps: 100, tapInstalls: 25, totalInstalls: 30 },
        ],
      },
      {
        metadata: { id: 444555667, name: 'Other app', promotedObjectType: 'APPSTORE_APP', promotedObjectId: '111', status: 'PAUSED' },
        granularMetrics: [{ date: '2026-11-01', localSpend: money('1.00'), impressions: 10, taps: 1 }],
      },
      { metadata: { name: 'No id' } },
    ],
    summary: { grandTotal: { localSpend: money('31.50'), impressions: 3010, taps: 151 } },
  },
  pagination: { totalCount: 3, offset: 0, pageSize: 1000 },
};

const keyword = (id: number, text: string, matchType: string) => ({ id, campaignId: 444555666, adAccountId: 123456789, text, status: 'ENABLED', matchType, adGroupId: 555666777 });

export const ADS_SEARCHTERM_REPORT = {
  result: {
    rows: [
      {
        metadata: { campaignId: 444555666, searchTermText: 'Photo Editor', searchTermSource: 'AUTO', keyword: keyword(1, 'photo', 'BROAD'), adGroupId: 555666777 },
        granularMetrics: [
          { date: '2026-11-01', countryOrRegion: 'US', localSpend: money('1.50'), impressions: 100, taps: 5, tapInstalls: 1 },
          { date: '2026-11-01', countryOrRegion: 'GB', localSpend: money('0.50'), impressions: 40, taps: 2, tapInstalls: 0 },
        ],
      },
      {
        // The same term matched by another keyword: merged by term, day and country.
        metadata: { campaignId: 444555666, searchTermText: 'photo editor', searchTermSource: 'TARGETED', keyword: keyword(2, 'photo editor', 'EXACT'), adGroupId: 555666778 },
        granularMetrics: [{ date: '2026-11-01', countryOrRegion: 'US', localSpend: money('2.00'), impressions: 300, taps: 20, tapInstalls: 4, totalInstalls: 5 }],
      },
      { metadata: { campaignId: 444555666, keyword: keyword(3, 'x', 'BROAD') }, granularMetrics: [] },
    ],
  },
  pagination: { totalCount: 3, offset: 0, pageSize: 1000 },
};

export const ADS_KEYWORD_REPORT = {
  result: {
    rows: [
      {
        metadata: { id: 888999000, text: 'photo', matchType: 'BROAD', status: 'ENABLED', adGroupId: 555666777 },
        granularMetrics: [{ date: '2026-11-01', countryOrRegion: 'US', localSpend: money('3.00'), impressions: 500, taps: 25, tapInstalls: 6 }],
      },
    ],
  },
  pagination: { totalCount: 1, offset: 0, pageSize: 1000 },
};

export const ADS_POPULARITY = {
  result: {
    rows: [
      { week: '2026-11-15', countryOrRegion: 'US', genre: 'PHOTO_VIDEO', searchTerm: 'photo editor', rankInGenre: 3, searchPopularityInGenre: 90, searchPopularity1to100: 84, searchPopularity1to5: 5 },
      { week: '2026-11-15', countryOrRegion: 'US', genre: 'PRODUCTIVITY_UTILITIES', searchTerm: 'photo editor', rankInGenre: 40, searchPopularityInGenre: 50, searchPopularity1to100: 61, searchPopularity1to5: 4 },
    ],
  },
  pagination: { offset: 0, pageSize: 20 },
};
