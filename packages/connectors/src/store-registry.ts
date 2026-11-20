import type { Platform, StoreCredentialKind } from '@mrm/core';

/**
 * What a connector is built from, whatever the store or the capability (read, reviews, draft, submit, rollout, release).
 * One shape, so a feature does not declare its own copy.
 */
export type StoreConnectorInput = {
  kind: StoreCredentialKind;
  /** The decrypted credential. Never log it or put it in a message. */
  secret: string;
  /** The bundle id or package name. */
  identifier: string;
  /** Apple's numeric app id; absent or null until the app's first sync (a read that lists apps does not need it). */
  storeAppId?: string | null;
  /** The platform of the app record: macOS reads and writes the macOS version of the same App Store Connect app. */
  platform?: Platform;
  /** Aborted when the call times out. Pass it to the connector as its `fetch`. */
  fetch: typeof fetch;
};

/** How to build a connector of one capability for each store. The record is exhaustive on purpose. */
export type StoreBuilders<Connector> = Readonly<
  Record<StoreCredentialKind, (input: StoreConnectorInput) => Connector>
>;

/**
 * A connector factory from one builder per store. Because the record must name every `StoreCredentialKind`, adding a store
 * (a new credential kind) makes the compiler list every capability that still lacks a builder for it, instead of the new
 * store silently getting Google Play's.
 */
export const connectorFactory =
  <Connector>(builders: StoreBuilders<Connector>) =>
  (input: StoreConnectorInput): Connector =>
    builders[input.kind](input);

/** The App Store Connect platform of an app record (Apple's macOS apps use their own version resources). */
export const appleScope = (input: Pick<StoreConnectorInput, 'platform'>): 'ios' | 'macos' =>
  input.platform === 'macos' ? 'macos' : 'ios';
