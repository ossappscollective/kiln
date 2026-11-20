/**
 * The shapes the Expo (EAS) client returns, and the one place later features add theirs (builds, submissions, updates, workflow runs).
 * Every field here was checked against Expo's own sources (docs/adr/0033-eas-integration.md lists where); a field that could not be
 * checked is not in this file. Keep each type to what its query selects, so a type never promises more than the query asked for.
 */

/** Who a token belongs to (`meActor`). `Actor` is an interface in Expo's schema; the concrete type is `__typename`. */
export type ExpoActorKind = 'robot' | 'user' | 'sso_user' | 'other';

export type ExpoAccountRef = {
  id: string;
  /** The account name, as it appears in `@name/slug`. */
  name: string;
};

export type ExpoViewer = {
  id: string;
  /** Expo's `__typename`: `Robot`, `User`, `SSOUser`, ... (kept as sent). */
  typename: string;
  kind: ExpoActorKind;
  /** The name Expo shows for the actor (a robot's name, a person's name). */
  displayName: string;
  /** Only a person (`UserActor`) has one; a robot has none. */
  username: string | null;
  /** The accounts the token can act on: the personal account and organizations it was granted. */
  accounts: ExpoAccountRef[];
};

/** An EAS project (Expo calls it an `App`). */
export type ExpoProject = {
  /** The project id (a UUID): `expo.extra.eas.projectId` of app.json. */
  id: string;
  name: string;
  /** `@account/slug`. */
  fullName: string;
  slug: string;
  ownerAccount: ExpoAccountRef;
};
