/**
 * Hand-written `store.config.json` files, shaped after the EAS Metadata docs and schema
 * (docs/spikes/expo-store-config.md). Not recorded from `eas metadata:pull`.
 */

export const STORE_PATH = 'store.config.json';

/** A full listing in two locales, 2-space indented, with a trailing newline. */
export const VALID = `{
  "configVersion": 0,
  "apple": {
    "copyright": "2026 Example, Inc.",
    "info": {
      "en-US": {
        "title": "Trail Notes",
        "subtitle": "Hike, log, share",
        "description": "Log every hike.\\n\\nShare it with friends.",
        "keywords": ["hiking", "trail", "gps"],
        "releaseNotes": "Bug fixes.",
        "promoText": "New: offline maps.",
        "marketingUrl": "https://example.com/promo",
        "supportUrl": "https://example.com/support",
        "privacyPolicyUrl": "https://example.com/privacy"
      },
      "de-DE": {
        "title": "Wegnotizen",
        "description": "Jede Wanderung festhalten.",
        "keywords": ["wandern", "wege"],
        "supportUrl": "https://example.com/de/support",
        "privacyPolicyUrl": "https://example.com/de/privacy"
      }
    }
  }
}
`;

/** The example from the EAS Metadata getting started page. */
export const MINIMAL = `{
  "configVersion": 0,
  "apple": {
    "info": {
      "en-US": {
        "title": "Awesome App",
        "subtitle": "Your self-made awesome app",
        "description": "The most awesome app you have ever seen",
        "keywords": ["awesome", "app"],
        "marketingUrl": "https://example.com/en/promo",
        "supportUrl": "https://example.com/en/support",
        "privacyPolicyUrl": "https://example.com/en/privacy"
      }
    }
  }
}
`;

/** Keys the listing model does not cover, and keys that are not in the EAS schema at all. */
export const UNKNOWN_FIELDS = `{
  "configVersion": 0,
  "notes": { "owner": "growth team" },
  "apple": {
    "version": "1.4.0",
    "copyright": "2026 Example, Inc.",
    "release": { "automaticRelease": false, "phasedRelease": true },
    "review": { "firstName": "Ada", "lastName": "Lovelace", "notes": "Use the demo account." },
    "categories": ["HEALTH_AND_FITNESS"],
    "futureFlag": true,
    "info": {
      "en-US": {
        "title": "Trail Notes",
        "keywords": ["hiking","trail"],
        "description": "Log every hike and share it.",
        "supportUrl": "https://example.com/support",
        "privacyPolicyUrl": "https://example.com/privacy",
        "privacyChoicesUrl": "https://example.com/choices",
        "screenshots": { "APP_IPHONE_67": ["./shots/1.png"] },
        "mystery": 1
      },
      "xx-YY": { "title": "Not a locale" }
    }
  }
}
`;

export const INVALID_JSON = `{
  "configVersion": 0,
  "apple": {
    "info": {
      "en-US": { "title": "Trail Notes", }
    }
  }
}
`;

/** Over every limit: title 31, subtitle 31, promo 171, keywords 101 bytes, release notes 4001. */
export const overLimit = (): string =>
  JSON.stringify(
    {
      configVersion: 0,
      apple: {
        copyright: '2026 Example, Inc.',
        info: {
          'en-US': {
            title: 'T'.repeat(31),
            subtitle: 'S'.repeat(31),
            description: 'D'.repeat(4001),
            keywords: ['k'.repeat(50), 'j'.repeat(50)],
            releaseNotes: 'R'.repeat(4001),
            promoText: 'P'.repeat(171),
            supportUrl: 'https://example.com/support',
            privacyPolicyUrl: 'https://example.com/privacy',
          },
        },
      },
    },
    null,
    2,
  );

/** Tab indented, CRLF line endings, keywords on several lines, no trailing newline. */
export const TABS_CRLF = [
  '{',
  '\t"configVersion": 0,',
  '\t"apple": {',
  '\t\t"info": {',
  '\t\t\t"en-US": {',
  '\t\t\t\t"title": "Trail Notes",',
  '\t\t\t\t"keywords": [',
  '\t\t\t\t\t"hiking",',
  '\t\t\t\t\t"trail"',
  '\t\t\t\t],',
  '\t\t\t\t"supportUrl": "https://example.com/support"',
  '\t\t\t}',
  '\t\t}',
  '\t}',
  '}',
].join('\r\n');

/** One line, no spaces. */
export const COMPACT =
  '{"configVersion":0,"apple":{"info":{"en-US":{"title":"Trail Notes","keywords":["a","b"]}}}}';
