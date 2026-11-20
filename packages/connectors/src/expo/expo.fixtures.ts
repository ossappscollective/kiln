/**
 * Response bodies shaped like Expo's GraphQL API, trimmed to the fields the client selects (see queries.ts for where each field was
 * checked). Written from eas-cli's query documents, not recorded from a live Expo account; the error wording is what eas-cli users
 * report in the wild and is UNVERIFIED.
 */

export const TOKEN = 'expo_tok_0123456789abcdefghijklmnop';
export const PROJECT_ID = '2f1c8e5a-7b3d-4c9e-8a61-0d5b9e4f7a12';
export const ACCOUNT = { id: 'acct-1', name: 'acme' };

export const robotViewer = () => ({
  data: {
    meActor: {
      __typename: 'Robot',
      id: 'robot-1',
      displayName: 'mobile-release-manager',
      accounts: [ACCOUNT],
    },
  },
});

export const userViewer = () => ({
  data: {
    meActor: {
      __typename: 'User',
      id: 'user-1',
      displayName: 'Ada Lovelace',
      username: 'ada',
      accounts: [{ id: 'acct-0', name: 'ada' }, ACCOUNT],
    },
  },
});

export const noViewer = () => ({ data: { meActor: null } });

export const project = (overrides: Record<string, unknown> = {}) => ({
  id: PROJECT_ID,
  name: 'Trail Notes',
  fullName: '@acme/trail-notes',
  slug: 'trail-notes',
  ownerAccount: ACCOUNT,
  ...overrides,
});

export const projectByFullName = (value: unknown = project()) => ({
  data: { app: { byFullName: value } },
});

export const projectById = (value: unknown = project()) => ({
  data: { app: { byId: value } },
});

export const graphqlError = (message: string, extensions: Record<string, unknown> = {}) => ({
  errors: [{ message, extensions }],
  data: null,
});

/** The app.json `eas init` writes. */
export const appJson = (projectId: string = PROJECT_ID) =>
  JSON.stringify(
    {
      expo: {
        name: 'Trail Notes',
        slug: 'trail-notes',
        owner: 'acme',
        extra: { eas: { projectId } },
      },
    },
    null,
    2,
  );
