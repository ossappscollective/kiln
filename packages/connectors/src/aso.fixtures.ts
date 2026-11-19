/**
 * Fixtures of the ASO connectors.
 *
 * `appleSearchReply` is RECORDED-STYLE: shaped like a reply of the public iTunes Search API for
 * `media=software` (the field names the service is widely observed to send), with invented values.
 * It was not saved from a live call (the test environment has no network). Apple documents only a few
 * of these fields (docs/api/aso.md lists which); the tests also run against a reply with most of them missing.
 *
 * `playSearchHtml` and `playAppHtml` are SYNTHETIC: written by hand to look like the markup the parsers
 * expect (links to `/store/apps/details?id=`, schema.org JSON-LD, og: meta tags). They were NOT saved from
 * Google Play, whose real markup was not checked. They prove the parser's logic, not that Google still
 * serves this markup.
 */

export const APPLE_OWN_ID = '1500000001';

const app = (n: number, over: Record<string, unknown> = {}) => ({
  wrapperType: 'software',
  kind: 'software',
  trackId: 1500000000 + n,
  trackName: `Habit App ${n}`,
  bundleId: `com.example.habit${n}`,
  version: `${n}.0.1`,
  formattedPrice: n % 2 === 0 ? 'Free' : '$2.99',
  price: n % 2 === 0 ? 0 : 2.99,
  currency: 'USD',
  averageUserRating: 4 + n / 20,
  userRatingCount: 1000 * n,
  description: `Habit App ${n} helps you build streaks.\nTrack your daily goals.`,
  artworkUrl512: `https://is1-ssl.mzstatic.com/image/thumb/Purple/v4/${n}/512x512bb.jpg`,
  screenshotUrls: [
    `https://is1-ssl.mzstatic.com/image/thumb/${n}/a.jpg`,
    `https://is1-ssl.mzstatic.com/image/thumb/${n}/b.jpg`,
  ],
  ipadScreenshotUrls: [`https://is1-ssl.mzstatic.com/image/thumb/${n}/c.jpg`],
  sellerName: `Maker ${n} GmbH`,
  primaryGenreName: 'Health & Fitness',
  trackViewUrl: `https://apps.apple.com/us/app/id${1500000000 + n}`,
  ...over,
});

export const appleSearchReply = {
  resultCount: 5,
  results: [app(2), app(1), app(7, { trackName: 'Café & Goals' }), app(3), app(4)],
};

export const appleLookupReply = { resultCount: 1, results: [app(1, { trackId: 1500000001 })] };

export const playSearchHtml = `<!doctype html><html lang="en"><head><title>habit tracker - Apps on Google Play</title></head><body>
<!-- SYNTHETIC fixture: hand written, not saved from Google Play -->
<div class="results">
  <a href="/store/apps/details?id=com.example.alpha&amp;hl=en&amp;gl=us"><span>Alpha Habits</span></a>
  <a href="/store/apps/details?id=com.example.beta"><span>Beta</span></a>
  <a href="/store/apps/details?id=com.example.alpha">again (a repeated link)</a>
  <a href="https://play.google.com/store/apps/details?id=com.example.own&hl=en"><span>Our App</span></a>
  <a href="/store/apps/dev?id=123">A developer page, not an app</a>
  <a href="/store/apps/details?id=nodots">not a package name</a>
  <a href="/store/apps/details?id=com.example.delta">Delta</a>
</div></body></html>`;

export const playAppHtml = `<!doctype html><html lang="en"><head>
<!-- SYNTHETIC fixture: hand written, not saved from Google Play -->
<title>Alpha Habits &amp; Goals - Apps on Google Play</title>
<meta property="og:title" content="Alpha Habits &amp; Goals - Apps on Google Play">
<meta property="og:description" content="Short description of Alpha.">
<meta property="og:image" content="https://play-lh.googleusercontent.com/alpha-icon=w512">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Alpha Habits & Goals","description":"Build streaks. Reach goals.","applicationCategory":"HEALTH_AND_FITNESS","softwareVersion":"3.4.1","author":{"@type":"Person","name":"Alpha Labs"},"aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","ratingCount":"20480"},"offers":[{"@type":"Offer","price":"0","priceCurrency":"USD"}],"image":"https://play-lh.googleusercontent.com/alpha-icon=w512"}</script>
</head><body>
<h1 itemprop="name"><span>Alpha Habits &amp; Goals</span></h1>
<div data-g-id="description">Build streaks.<br>Reach goals.<br>No ads &amp; no login.</div>
<img data-screenshot-index="0" src="x"><img data-screenshot-index="1" src="y"><img data-screenshot-index="2" src="z">
</body></html>`;

/** An app page whose markup has lost everything the parser looks for. */
export const playChangedHtml =
  '<!doctype html><html><head><title></title></head><body><div id="root"></div></body></html>';
