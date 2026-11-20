import type { ExpoGraphql } from './client.ts';
import { ExpoError } from './errors.ts';
import type { ExpoAccountRef, ExpoActorKind, ExpoProject, ExpoViewer } from './types.ts';

/**
 * The typed queries. Each one is the query text, the variables and a reader that checks what came back (nothing is trusted to have
 * the shape it should). Later features add theirs here or in their own file next to this one, and a type for each in types.ts.
 *
 * Verified against Expo's open source (expo/eas-cli, packages/eas-cli/src/graphql, checked 2026-11-20):
 * - `meActor` (queries/UserQuery.ts, types/Actor.ts): `__typename`, `id`, `displayName` (Actor interface), `accounts { id name }`,
 *   and `... on UserActor { username }`.
 * - `app { byId(appId: String!) }` and `app { byFullName(fullName: String!) }` (queries/AppQuery.ts) with `id name fullName slug
 *   ownerAccount { id name }` (types/App.ts).
 * NOT verified, so not used: what `meActor` answers for a token Expo does not know (this client treats `null` and an authentication
 * error alike), the exact error codes, and any field of builds, submissions, updates or workflows.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

const unreadable = () => new ExpoError('unexpected');

function accountOf(value: unknown): ExpoAccountRef {
  if (!isRecord(value)) throw unreadable();
  const id = text(value.id);
  const name = text(value.name);
  if (!id || !name) throw unreadable();
  return { id, name };
}

const actorKinds: Record<string, ExpoActorKind> = {
  Robot: 'robot',
  User: 'user',
  UserActor: 'user',
  SSOUser: 'sso_user',
};

export const VIEWER_QUERY = `query MrmViewer {
  meActor {
    __typename
    id
    displayName
    ... on UserActor { username }
    accounts { id name }
  }
}`;

/** Who the token belongs to, or `null` when Expo does not know the token. */
export async function expoViewer(client: ExpoGraphql): Promise<ExpoViewer | null> {
  const data = await client.graphql<{ meActor?: unknown }>({
    query: VIEWER_QUERY,
    operationName: 'MrmViewer',
  });
  const actor = data.meActor;
  if (actor === null || actor === undefined) return null;
  if (!isRecord(actor)) throw unreadable();
  const id = text(actor.id);
  const typename = text(actor.__typename);
  if (!id || !typename) throw unreadable();
  const accounts = Array.isArray(actor.accounts) ? actor.accounts.map(accountOf) : [];
  return {
    id,
    typename,
    kind: actorKinds[typename] ?? 'other',
    displayName: text(actor.displayName) ?? text(actor.username) ?? typename,
    username: text(actor.username) ?? null,
    accounts,
  };
}

const PROJECT_FIELDS = 'id name fullName slug ownerAccount { id name }';

function projectOf(value: unknown): ExpoProject {
  if (!isRecord(value)) throw unreadable();
  const id = text(value.id);
  const slug = text(value.slug);
  const fullName = text(value.fullName);
  if (!id || !slug || !fullName) throw unreadable();
  return {
    id,
    name: text(value.name) ?? slug,
    fullName,
    slug,
    ownerAccount: accountOf(value.ownerAccount),
  };
}

/** A project id is a UUID (`expo.extra.eas.projectId`). */
export const EXPO_PROJECT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isExpoProjectId = (value: string): boolean => EXPO_PROJECT_ID.test(value);

/** `@account/slug` from `@account/slug` or `account/slug`; undefined when it is neither. */
export function normalizeExpoFullName(value: string): string | undefined {
  const match = /^@?([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(
    value.trim(),
  );
  return match ? `@${match[1]}/${match[2]}` : undefined;
}

export const PROJECT_BY_FULL_NAME_QUERY = `query MrmProjectByFullName($fullName: String!) {
  app { byFullName(fullName: $fullName) { ${PROJECT_FIELDS} } }
}`;

export const PROJECT_BY_ID_QUERY = `query MrmProjectById($appId: String!) {
  app { byId(appId: $appId) { ${PROJECT_FIELDS} } }
}`;

/** The project `@account/slug` (or `account/slug`). `not_found` when Expo has none the token can see. */
export async function expoProjectByFullName(
  client: ExpoGraphql,
  fullName: string,
): Promise<ExpoProject> {
  const normalized = normalizeExpoFullName(fullName);
  if (!normalized) throw new ExpoError('invalid_input');
  const data = await client.graphql<{ app?: unknown }>({
    query: PROJECT_BY_FULL_NAME_QUERY,
    variables: { fullName: normalized },
    operationName: 'MrmProjectByFullName',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byFullName === null) throw new ExpoError('not_found');
  return projectOf(data.app.byFullName);
}

/** The project with this id (a UUID). `not_found` when Expo has none the token can see. */
export async function expoProjectById(client: ExpoGraphql, projectId: string): Promise<ExpoProject> {
  if (!isExpoProjectId(projectId)) throw new ExpoError('invalid_input');
  const data = await client.graphql<{ app?: unknown }>({
    query: PROJECT_BY_ID_QUERY,
    // Project ids are lower case UUIDs; an id typed in capitals is the same id.
    variables: { appId: projectId.toLowerCase() },
    operationName: 'MrmProjectById',
  });
  if (!isRecord(data.app)) throw unreadable();
  if (data.app.byId === null) throw new ExpoError('not_found');
  return projectOf(data.app.byId);
}
