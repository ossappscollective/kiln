/**
 * Hand-written `eas.json` and app config files, shaped after the Expo pages listed in docs/api/eas-config.md. Not recorded from a
 * real project. Every "secret" below is invented.
 */

/** What `eas init` writes (the three profiles of docs.expo.dev/build-reference/build-configuration), plus `cli`. */
export const DEFAULT_EAS = `{
  "cli": { "version": ">= 16.0.0", "appVersionSource": "remote" },
  "build": {
    "development": { "developmentClient": true, "distribution": "internal" },
    "preview": { "distribution": "internal", "channel": "preview" },
    "production": { "channel": "production", "autoIncrement": true }
  },
  "submit": { "production": {} }
}
`;

export const SECRET_TOKEN = 'ghp_0123456789abcdefghijklmnopqrstuvwxyz';
export const SENTRY_TOKEN = 'sntrys_a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';

/** Extends chains, platform sections, env (with secrets), and submit profiles for both stores. */
export const FULL_EAS = `{
  "cli": { "version": ">= 16.0.0", "requireCommit": true, "appVersionSource": "local", "promptToConfigurePushNotifications": false },
  "build": {
    "base": {
      "node": "22.11.0",
      "distribution": "store",
      "env": { "API_URL": "https://api.example.com", "FLAVOR": "base" },
      "android": { "buildType": "app-bundle", "image": "latest", "env": { "ANDROID_ONLY": "1" } },
      "ios": { "resourceClass": "m-medium", "buildConfiguration": "Release" }
    },
    "preview": {
      "extends": "base",
      "distribution": "internal",
      "channel": "preview",
      "developmentClient": false,
      "env": { "FLAVOR": "preview", "SENTRY_AUTH_TOKEN": "${SENTRY_TOKEN}" },
      "android": { "buildType": "apk" },
      "ios": { "simulator": true }
    },
    "production": {
      "extends": "base",
      "channel": "production",
      "autoIncrement": true,
      "env": { "GITHUB": "${SECRET_TOKEN}", "REF": "$API_URL_FROM_EAS" },
      "ios": { "autoIncrement": "buildNumber", "channel": "production-ios" }
    }
  },
  "submit": {
    "production": {
      "ios": {
        "appleId": "dev@example.com",
        "ascAppId": "1234567890",
        "appleTeamId": "ABCDE12345",
        "sku": "trailnotes",
        "language": "en-US",
        "companyName": "Example, Inc.",
        "appName": "Trail Notes",
        "bundleIdentifier": "com.example.trailnotes",
        "ascApiKeyPath": "./keys/AuthKey_ABC.p8",
        "ascApiKeyIssuerId": "11111111-2222-3333-4444-555555555555",
        "ascApiKeyId": "ABC123",
        "metadataPath": "./store.config.json",
        "groups": ["Internal testers"]
      },
      "android": {
        "serviceAccountKeyPath": "$GOOGLE_SERVICE_ACCOUNT_KEY_PATH",
        "track": "production",
        "releaseStatus": "inProgress",
        "rollout": 0.1,
        "changesNotSentForReview": true,
        "applicationId": "com.example.trailnotes"
      }
    },
    "preview": { "extends": "production", "android": { "track": "internal", "releaseStatus": "completed" } }
  },
  "x-future": { "token": "do-not-keep-this-value" }
}
`;

/** Comments and trailing commas: not JSON, read anyway. A URL holds `//` and a string holds `/*`. */
export const COMMENTED_EAS = `// Build setup
{
  /* the cli block */
  "cli": { "version": ">= 16.0.0", /* inline */ "appVersionSource": "local", },
  "build": {
    "production": {
      "channel": "production", // the OTA channel
      "env": { "DOCS": "https://docs.example.com/a/*not-a-comment*/b", },
    },
  },
}
`;

export const INVALID_EAS = `{
  "build": {
    "production": { "env": { "API_TOKEN": "${SECRET_TOKEN}" } "channel": "x" }
  }
}
`;

export const CYCLE_EAS = JSON.stringify({
  build: {
    a: { extends: 'b' },
    b: { extends: 'c' },
    c: { extends: 'b' },
    self: { extends: 'self' },
    fine: { channel: 'fine' },
  },
});

export const MISSING_EAS = JSON.stringify({
  build: { child: { extends: 'nope', channel: 'x' }, other: { extends: 7 } },
  submit: { child: { extends: 'missing-submit' } },
});

/** Seven profiles in a row: more than the five steps Expo allows. */
export const DEEP_EAS = JSON.stringify({
  build: {
    p0: { channel: 'zero' },
    p1: { extends: 'p0' },
    p2: { extends: 'p1' },
    p3: { extends: 'p2' },
    p4: { extends: 'p3' },
    p5: { extends: 'p4' },
    p6: { extends: 'p5' },
  },
});

export const PROTO_EAS = `{
  "build": {
    "__proto__": { "channel": "evil", "polluted": true },
    "constructor": { "extends": "__proto__" },
    "ok": { "__proto__": { "x": 1 }, "env": { "__proto__": "x" } }
  }
}`;

export const WRONG_TYPES_EAS = JSON.stringify({
  cli: 'remote',
  build: {
    bad: 'not an object',
    typed: {
      channel: 5,
      developmentClient: 'yes',
      autoIncrement: {},
      env: ['A'],
      ios: 'x',
      android: { buildType: 3 },
      distribution: 'ota',
    },
    good: { channel: 'good' },
  },
  submit: {
    typed: { ios: { ascAppId: 1, groups: 'a' }, android: { rollout: '0.5', track: 'nightly' } },
  },
});

export const app = (cfg: Record<string, unknown>, wrapped = true) =>
  JSON.stringify(wrapped ? { expo: cfg } : cfg);

export const APP_UPDATES = app({
  name: 'Trail Notes',
  slug: 'trail-notes',
  version: '1.4.0',
  runtimeVersion: { policy: 'appVersion' },
  updates: { url: 'https://u.expo.dev/0cd3da2d-1111-2222-3333-444444444444' },
  extra: { eas: { projectId: '0cd3da2d-1111-2222-3333-444444444444' } },
  ios: { bundleIdentifier: 'com.example.trailnotes', buildNumber: '12' },
  android: { package: 'com.example.trailnotes', versionCode: 34 },
});

export const APP_PLAIN = app({
  name: 'Trail Notes',
  slug: 'trail-notes',
  version: '1.4.0',
  ios: { bundleIdentifier: 'com.example.trailnotes' },
  android: { package: 'com.example.trailnotes' },
});
