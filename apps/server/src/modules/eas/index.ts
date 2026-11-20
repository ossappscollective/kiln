import type { ServerModule } from '../module.ts';
import { easParts } from './parts.ts';

/**
 * Expo Application Services (docs/adr/0033-eas-integration.md): the link between an app and its EAS project, EAS Workflows as a CI
 * provider, EAS Build and Submit status, EAS Update (OTA) and the reading of `eas.json`. The module is a list of parts (parts.ts); each
 * feature owns its files in this folder and adds one entry. Nothing here calls Expo unless a workspace has an Expo credential.
 */
export type EasDeps = {
  /** Replaces the network for every call to Expo (tests use a fake). */
  fetch?: typeof fetch | undefined;
  /** The GraphQL and REST origin of Expo, default https://api.expo.dev. Tests and self-hosted proxies set it. */
  apiOrigin?: string | undefined;
};

export const easModule: ServerModule<EasDeps> = {
  id: 'eas',
  mount(app, services, deps, shared) {
    for (const part of easParts) part(app, services, deps, shared);
  },
};
