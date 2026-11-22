import * as fx from './store.fixtures.ts';

/**
 * Hand-written fixtures for the TestFlight feedback connector. They follow the endpoint, attribute and parameter names on Apple's reference
 * pages (see apple/appstore-testflight-feedback.ts) and are NOT recordings of live traffic: no response was seen from a real account, so the
 * JSON:API `type` strings, the linkage and the layout of `logText` are the ones the connector expects.
 */

export const APP = '6740123456';
export const T0 = Date.UTC(2026, 10, 22, 12, 0, 0);

export const FEEDBACK_LIST =
  /^\/v1\/apps\/6740123456\/betaFeedbackScreenshotSubmissions\?sort=-createdDate&limit=200&include=build/;
export const CRASH_LIST =
  /^\/v1\/apps\/6740123456\/betaFeedbackCrashSubmissions\?sort=-createdDate&limit=200&include=build/;

const linkage = (type: string, idValue: string) => ({ data: { type, id: idValue } });

export const build = (idValue: string, number: string) => ({
  type: 'builds',
  id: idValue,
  attributes: { version: number },
});

export const submission = (
  type: 'betaFeedbackScreenshotSubmissions' | 'betaFeedbackCrashSubmissions',
  idValue: string,
  buildId: string | null,
  over: Record<string, unknown> = {},
) => ({
  type,
  id: idValue,
  attributes: {
    createdDate: '2026-11-20T09:30:00Z',
    comment: 'The button does nothing',
    email: 'tester@example.com',
    deviceModel: 'iPhone16,2',
    osVersion: '18.1',
    locale: 'fr_FR',
    timeZone: 'Europe/Paris',
    architecture: 'arm64e',
    connectionType: 'WIFI',
    pairedAppleWatch: null,
    appUptimeInMilliseconds: 61_000,
    diskBytesAvailable: 12_000_000_000,
    diskBytesTotal: 128_000_000_000,
    batteryPercentage: 80,
    screenWidthInPoints: 430,
    screenHeightInPoints: 932,
    appPlatform: 'IOS',
    devicePlatform: 'IOS',
    deviceFamily: 'IPHONE',
    buildBundleId: 'com.example.app',
    someFutureField: { nested: true },
    ...over,
  },
  relationships: buildId === null ? {} : { build: linkage('builds', buildId) },
});

export const screenshotSubmission = (idValue: string, buildId: string | null, over: Record<string, unknown> = {}) =>
  submission('betaFeedbackScreenshotSubmissions', idValue, buildId, {
    screenshots: [
      { url: 'https://example.invalid/shot-1.png', width: 1290, height: 2796, expirationDate: '2026-11-22T13:00:00Z' },
      { url: 'https://example.invalid/shot-2.png', width: 1290, height: 2796, expirationDate: '2026-11-22T13:00:00Z' },
    ],
    ...over,
  });

export const crashSubmission = (idValue: string, buildId: string | null, over: Record<string, unknown> = {}) =>
  submission('betaFeedbackCrashSubmissions', idValue, buildId, { comment: 'It crashed when I opened settings', ...over });

/** An Apple `.crash` text, abbreviated: the layout the signature rule expects (UNVERIFIED for TestFlight). */
export const CRASH_LOG = `Incident Identifier: 1A2B3C4D
Hardware Model:      iPhone16,2
Process:             Example [1234]
Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Exception Codes: KERN_INVALID_ADDRESS at 0x0000000000000010
Triggered by Thread:  0

Thread 0 name:  Dispatch queue: com.apple.main-thread
Thread 0 Crashed:
0   Example                       \t0x0000000102abc123 -[SettingsViewController reload] + 84 (SettingsViewController.m:42)
1   UIKitCore                     \t0x00000001a1b2c3d4 -[UIViewController _sendViewDidLoad] + 100

Thread 1:
0   libsystem_kernel.dylib        \t0x00000001d0e1f2a3 mach_msg2_trap + 8
`;

export const UNSYMBOLICATED_LOG = `Exception Type:  EXC_BREAKPOINT (SIGTRAP)
Thread 3 Crashed:
0   Example                       0x0000000102abc123 0x102a00000 + 770339
1   Example                       0x0000000102abc999 0x102a00000 + 772505
`;

export function feedbackFake(): fx.FakeFetch {
  return new fx.FakeFetch()
    .on({
      method: 'GET',
      match: FEEDBACK_LIST,
      json: {
        data: [
          screenshotSubmission('f1', 'b1'),
          screenshotSubmission('f2', 'b2', { appPlatform: 'MAC_OS', createdDate: '2026-11-19T09:30:00Z' }),
          screenshotSubmission('f3', null, { email: null, screenshots: [], createdDate: 'not a date' }),
          { type: 'betaFeedbackScreenshotSubmissions' },
        ],
        included: [build('b1', '42'), build('b2', '43')],
      },
    })
    .on({
      method: 'GET',
      match: CRASH_LIST,
      json: { data: [crashSubmission('c1', 'b1')], included: [build('b1', '42')] },
    })
    .on({
      method: 'GET',
      match: '/v1/builds/b1/preReleaseVersion?fields[preReleaseVersions]=version,platform',
      json: { data: { type: 'preReleaseVersions', id: 'p1', attributes: { version: '2.5.0', platform: 'IOS' } } },
    });
}
