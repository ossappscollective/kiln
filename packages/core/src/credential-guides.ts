import type { CredentialKind } from './credentials.ts';

/**
 * How-to content shown next to the credential form: how to obtain each kind of secret, written
 * for someone doing it for the first time. Content, not logic, so it can be edited and reviewed
 * like documentation. Every external page named here must have been opened and checked, and the
 * date it was checked goes in `checkedOn`.
 */
export type GuideLink = { label: string; url: string };

export type GuideStep = {
  /** A short imperative, e.g. "Open Users and Access". */
  title: string;
  /** One or two sentences. Plain text; no markup. */
  body: string;
  /** The page that explains this step in the vendor's own words, if there is one. */
  link?: GuideLink;
};

export type CredentialGuide = {
  /** One sentence: what this credential lets the tool do, and what it cannot. */
  summary: string;
  /** Account, role or plan the person needs before they start. */
  prerequisites: string[];
  steps: GuideStep[];
  /** The least access the tool needs, so people do not grant more than necessary. */
  permissions: string[];
  /** Common failures with a fix for each. */
  troubleshooting: { problem: string; fix: string }[];
  /** Official documentation to read for more. */
  links: GuideLink[];
  /** ISO date (YYYY-MM-DD) when the links and steps were last checked against the vendor pages. */
  checkedOn: string;
};

const CHECKED_ON = '2026-11-18';

const appStoreConnect: CredentialGuide = {
  summary:
    'Lets the tool read and manage your apps in App Store Connect with a team API key; the key never leaves this server.',
  prerequisites: [
    'An Account Holder or Admin account in App Store Connect. Apple allows only these roles to generate team keys.',
    'API access enabled for the team. Apple says the Account Holder must request it once, and requests are reviewed case by case.',
    'A secure place for the .p8 file, because Apple lets you download it only one time.',
  ],
  steps: [
    {
      title: 'Check your role',
      body: 'Sign in to App Store Connect with an Account Holder or Admin account. Other roles cannot generate team keys.',
      link: {
        label: 'Apple: Generate a team API key',
        url: 'https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/',
      },
    },
    {
      title: 'Request API access',
      body: 'If the Integrations tab asks for it, have the Account Holder request access to the App Store Connect API. Wait for Apple to approve it.',
      link: {
        label: 'Apple: App Store Connect API help',
        url: 'https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/',
      },
    },
    {
      title: 'Open the Integrations tab',
      body: 'Select Users and Access, then the Integrations tab. Select App Store Connect API in the left column and make sure Team Keys is selected.',
      link: {
        label: 'Apple: Creating API keys',
        url: 'https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api',
      },
    },
    {
      title: 'Generate the key',
      body: 'Click Generate API Key or the Add button and enter a name. The name is for your reference only and is not part of the key.',
    },
    {
      title: 'Choose the access role',
      body: 'Under Access, select a role for the key, for example App Manager. You cannot change the role later, so revoke the key and generate a new one to change it.',
    },
    {
      title: 'Download the private key',
      body: 'Click Download API Key next to the new key and keep the .p8 file somewhere safe. Apple allows one download and keeps no copy.',
    },
    {
      title: 'Copy the Key ID',
      body: 'Find the key in the Active list on the Integrations page, hover next to its Key ID, and click Copy Key ID.',
      link: {
        label: 'Apple: Generating tokens for API requests',
        url: 'https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests',
      },
    },
    {
      title: 'Copy the Issuer ID',
      body: 'The Issuer ID is near the top of the same page. Click Copy next to it.',
    },
    {
      title: 'Enter the values here',
      body: 'Paste the Issuer ID and Key ID into the form and add the full contents of the .p8 file as the private key. Delete any other copies of the file you no longer need.',
    },
  ],
  permissions: [
    'Use the least powerful role that covers what you want the tool to do. App Manager is described by Apple as managing pricing, App Store information, and delivery of an app.',
    'Avoid the Admin role unless you need it. Apple notes Admin keys can create and delete users.',
    'Team keys apply to all apps in the account. Apple provides no way to limit a team key to one app.',
    'Do not use an individual key: it cannot call some endpoints and is tied to one person.',
  ],
  troubleshooting: [
    {
      problem: 'There is no Integrations tab, or no Generate API Key button.',
      fix: 'You probably lack the Account Holder or Admin role, or API access was not requested yet. Ask the Account Holder to request access, or to generate the key.',
    },
    {
      problem: 'There is no Download API Key link next to my key.',
      fix: 'Apple shows the link only until the first download and keeps no copy. Revoke the key, generate a new one, and download it right away.',
    },
    {
      problem: 'The tool answers 401 Unauthorized.',
      fix: 'Check that the Key ID matches the .p8 file it was downloaded with and that the Issuer ID is from the Team Keys page. Also check that the key has not been revoked.',
    },
    {
      problem: 'The tool answers 403 Forbidden for an action.',
      fix: 'The role chosen for the key does not allow that action. Roles cannot be edited, so generate a new key with a broader role.',
    },
    {
      problem: 'The key was shared or the file was lost.',
      fix: 'Revoke it in Users and Access, Keys tab, then generate a new one. Revoked keys cannot be reinstated.',
    },
  ],
  links: [
    {
      label: 'Creating API keys for App Store Connect API',
      url: 'https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api',
    },
    {
      label: 'Generating tokens for API requests',
      url: 'https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests',
    },
    {
      label: 'Revoking API keys',
      url: 'https://developer.apple.com/documentation/appstoreconnectapi/revoking-api-keys',
    },
    {
      label: 'App Store Connect help: API keys',
      url: 'https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/',
    },
    {
      label: 'Role permissions',
      url: 'https://developer.apple.com/help/app-store-connect/reference/account-management/role-permissions',
    },
  ],
  checkedOn: CHECKED_ON,
};

const googlePlay: CredentialGuide = {
  summary:
    'Lets the tool read and manage your apps in Google Play Console through a service account you create and invite.',
  prerequisites: [
    'A Google Play Console developer account where you can invite users. Look for the Invite new users button under Users and permissions.',
    'A Google Cloud project where you may create service accounts and keys. Your organization may block key creation with a policy.',
    'Somewhere secure to keep the JSON key file, which Google lets you download only once.',
  ],
  steps: [
    {
      title: 'Create a Cloud project',
      body: 'Open the Google Cloud console and create a project, or pick an existing one. You no longer need to link it to your Play developer account.',
      link: {
        label: 'Google: Getting started with the Play Developer API',
        url: 'https://developers.google.com/android-publisher/getting_started',
      },
    },
    {
      title: 'Enable the Play Developer API',
      body: 'In that project, find the Google Play Android Developer API in the API library and click Enable. Google\'s docs call it the Google Play Developer API.',
      link: {
        label: 'Google: Getting started with the Play Developer API',
        url: 'https://developers.google.com/android-publisher/getting_started',
      },
    },
    {
      title: 'Create a service account',
      body: 'Open the Service accounts page, click Create service account, and enter a name. The ID cannot be changed later, and project roles are optional.',
      link: {
        label: 'Google Cloud: Create service accounts',
        url: 'https://cloud.google.com/iam/docs/service-accounts-create',
      },
    },
    {
      title: 'Create a JSON key',
      body: 'Open the service account, select the Keys tab, click Add key, then Create new key, and choose JSON. The file downloads once and cannot be fetched again.',
      link: {
        label: 'Google Cloud: Create service account keys',
        url: 'https://cloud.google.com/iam/docs/keys-create-delete',
      },
    },
    {
      title: 'Copy the service account email',
      body: 'Copy the email address of the service account. It ends in iam.gserviceaccount.com and is also the client_email value in the JSON file.',
    },
    {
      title: 'Open Users and permissions',
      body: 'In Play Console, open Users and permissions from the main menu and click Invite new users.',
      link: {
        label: 'Play Console Help: Add developer account users',
        url: 'https://support.google.com/googleplay/android-developer/answer/9844686',
      },
    },
    {
      title: 'Invite the service account',
      body: 'Enter the service account email under User details. Do not make it an account admin.',
    },
    {
      title: 'Grant app permissions',
      body: 'In App permissions, add the apps the tool should manage and tick only the permissions listed in this guide. Click Invite user.',
    },
    {
      title: 'Enter the JSON key here',
      body: 'Paste the full contents of the JSON key file into the form. Delete other copies of the file you no longer need.',
    },
  ],
  permissions: [
    'Give the service account access only to the apps the tool will manage, not the whole account.',
    'Releases: Release apps to testing tracks lets it roll out to testing tracks and does not allow publishing to production.',
    'Release to production, exclude devices, and use Play App Signing is needed only if the tool should publish to production.',
    'Store listing: Manage store presence lets it edit listing text and graphics.',
    'Reading: View app information (read-only) gives read-only access to the app, excluding financial data.',
  ],
  troubleshooting: [
    {
      problem: 'The API returns 401 or 403 soon after creating the service account or inviting it.',
      fix: 'Check that the invitation shows in Users and permissions and that the right apps and permissions are set. Then wait and retry, because new access may take time to apply.',
    },
    {
      problem: 'The API says the app or package name is not found.',
      fix: 'The service account has no permission on that app. Add the app under App permissions for the service account, or check the package name for typos.',
    },
    {
      problem: 'The API reports that the Google Play Android Developer API is not enabled.',
      fix: 'Enable it in the same Cloud project that owns the service account. A key from a different project will fail with this error.',
    },
    {
      problem: 'The Cloud console refuses to create a JSON key.',
      fix: 'Your organization may enforce the iam.disableServiceAccountKeyCreation policy. Ask a Cloud administrator for an exception for this project.',
    },
    {
      problem: 'The JSON file was lost or leaked.',
      fix: 'Delete the key on the Keys tab of the service account and create a new one. Google does not allow downloading an existing key again.',
    },
  ],
  links: [
    {
      label: 'Getting started with the Google Play Developer API',
      url: 'https://developers.google.com/android-publisher/getting_started',
    },
    {
      label: 'Create service accounts',
      url: 'https://cloud.google.com/iam/docs/service-accounts-create',
    },
    {
      label: 'Create and delete service account keys',
      url: 'https://cloud.google.com/iam/docs/keys-create-delete',
    },
    {
      label: 'Play Console Help: Add developer account users and manage permissions',
      url: 'https://support.google.com/googleplay/android-developer/answer/9844686',
    },
  ],
  checkedOn: CHECKED_ON,
};

const githubApp: CredentialGuide = {
  summary:
    'Lets the tool read files, create branches and commits, open pull requests, and run workflows in the repositories you choose.',
  prerequisites: [
    'To register the app: your own GitHub account, or an organization where you may manage apps.',
    'To install it on an organization, you may need an owner, or an approval from one. GitHub shows what is allowed on the install page.',
    'The repositories the tool should work on, so you can select exactly those at install time.',
  ],
  steps: [
    {
      title: 'Open GitHub Apps settings',
      body: 'Open your account settings, or the settings of the organization that will own the app. Select Developer settings, then GitHub Apps.',
      link: {
        label: 'GitHub: Registering a GitHub App',
        url: 'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
      },
    },
    {
      title: 'Start a new GitHub App',
      body: 'Click New GitHub App. Enter a unique name of up to 34 characters and a homepage URL, such as your repository URL.',
      link: {
        label: 'GitHub: Registering a GitHub App',
        url: 'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
      },
    },
    {
      title: 'Turn off webhooks',
      body: 'Clear the Active checkbox under Webhook, because the tool does not use webhook events.',
    },
    {
      title: 'Set repository permissions',
      body: 'Under Repository permissions, set Contents, Pull requests and Actions to Read and write. Keep Metadata at Read-only.',
      link: {
        label: 'GitHub: Permissions required for GitHub Apps',
        url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps',
      },
    },
    {
      title: 'Create the app',
      body: 'Choose Only on this account for where the app can be installed, then click Create GitHub App.',
    },
    {
      title: 'Copy the App ID',
      body: 'On the app settings page, copy the value labeled App ID.',
      link: {
        label: 'GitHub: Generating a JWT for a GitHub App',
        url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app',
      },
    },
    {
      title: 'Generate a private key',
      body: 'Under Credentials, Key pairs, click New key. A .pem file downloads to your computer, and GitHub keeps only the public half.',
      link: {
        label: 'GitHub: Managing private keys',
        url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps',
      },
    },
    {
      title: 'Install the app',
      body: 'On the app, click Install App and choose the account. Choose only selected repositories and pick the ones the tool should use.',
      link: {
        label: 'GitHub: Installing your own GitHub App',
        url: 'https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app',
      },
    },
    {
      title: 'Copy the Installation ID',
      body: 'Open the installation settings page and copy the number at the end of its URL; for an organization it looks like github.com/organizations/ORG/settings/installations/ID. You can also call GET /app/installations.',
      link: {
        label: 'GitHub: Authenticating as an installation',
        url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation',
      },
    },
  ],
  permissions: [
    'Contents: Read and write, to read files and create branches and commits.',
    'Pull requests: Read and write, to open pull requests.',
    'Actions: Read and write, to dispatch workflows and read their runs.',
    'Metadata: Read-only, which GitHub grants for repository access.',
    'Select only the repositories the tool needs, not all repositories.',
  ],
  troubleshooting: [
    {
      problem: 'I cannot find the Installation ID.',
      fix: 'Open the installation settings page for the app; the ID is the last number in the URL. Or call GET /app/installations with a JWT signed by the app key.',
    },
    {
      problem: 'The API answers 404 for a repository that exists.',
      fix: 'The app is not installed on that repository. Edit the installation and add the repository under Repository access.',
    },
    {
      problem: 'The API answers 403 for an action the app should be able to do.',
      fix: 'The app lacks a permission for that call. Raise the permission in the app settings, then approve the updated permissions on the installation if GitHub asks.',
    },
    {
      problem: 'The API answers 401 when the tool signs in as the app.',
      fix: 'Check the App ID and the .pem file belong to the same app. Also check the server clock, because GitHub rejects tokens whose expiry is more than 10 minutes ahead.',
    },
    {
      problem: 'The .pem file was lost or leaked.',
      fix: 'Generate a new key under Credentials, Key pairs, then delete the old one. GitHub does not store the private half.',
    },
  ],
  links: [
    {
      label: 'Registering a GitHub App',
      url: 'https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app',
    },
    {
      label: 'Managing private keys for GitHub Apps',
      url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps',
    },
    {
      label: 'Installing your own GitHub App',
      url: 'https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app',
    },
    {
      label: 'Permissions required for GitHub Apps',
      url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps',
    },
    {
      label: 'Authenticating as a GitHub App installation',
      url: 'https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation',
    },
  ],
  checkedOn: CHECKED_ON,
};

const githubToken: CredentialGuide = {
  summary:
    'A personal token acts as you. It is meant for trying the tool out; use a GitHub App for a team or for production.',
  prerequisites: [
    'A GitHub account with write access to the repositories the tool will change.',
    'A verified email address on the account, which GitHub asks for before creating a fine-grained token.',
    'If the repositories belong to an organization, an owner may need to approve the token before it can reach them.',
  ],
  steps: [
    {
      title: 'Open token settings',
      body: 'Open Settings from your profile menu, then Developer settings. Under Personal access tokens, select Fine-grained tokens.',
      link: {
        label: 'GitHub: Managing your personal access tokens',
        url: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
      },
    },
    {
      title: 'Generate a new token',
      body: 'Click Generate new token, enter a name, and choose a short expiration, since the token acts with your access.',
    },
    {
      title: 'Choose the resource owner',
      body: 'Select the user or organization that owns the repositories. A token reaches only resources owned by the owner you pick.',
    },
    {
      title: 'Select the repositories',
      body: 'Under Repository access, choose Only select repositories and pick the ones the tool needs. GitHub advises the minimal access that works.',
    },
    {
      title: 'Set repository permissions',
      body: 'Set Contents, Pull requests and Actions to Read and write. Metadata is read-only.',
      link: {
        label: 'GitHub: Permissions required for fine-grained tokens',
        url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens',
      },
    },
    {
      title: 'Generate and copy the token',
      body: 'Click Generate token and copy the value into the form right away. Look for a notice on the page about whether you can see it again.',
    },
    {
      title: 'Wait for approval if needed',
      body: 'If the organization requires approval, the token stays pending and can read only public data. An organization owner approves it from the organization settings.',
    },
  ],
  permissions: [
    'Contents: Read and write, to read files and create branches and commits.',
    'Pull requests: Read and write, to open pull requests.',
    'Actions: Read and write, to dispatch workflows and read their runs.',
    'Metadata: Read-only.',
    'Prefer a fine-grained token. A classic token with the repo scope can reach every repository you can, and GitHub recommends fine-grained tokens instead.',
  ],
  troubleshooting: [
    {
      problem: 'The API answers 404 for a private repository.',
      fix: 'The token was not given that repository. Edit the token and add it under Repository access, or check that the resource owner is correct.',
    },
    {
      problem: 'An organization repository is read-only or unreachable.',
      fix: 'The token may still be pending approval. Ask an organization owner to approve it, or check the organization policy on fine-grained tokens.',
    },
    {
      problem: 'The API answers 403 for an action the token should be able to do.',
      fix: 'A permission is missing. Edit the token, set the missing permission to Read and write, and retry.',
    },
    {
      problem: 'The API answers 401 Bad credentials.',
      fix: 'The token is expired, revoked, or copied with extra characters. Generate a new one and paste it without spaces or line breaks.',
    },
    {
      problem: 'A classic token fails to change files under .github/workflows.',
      fix: 'GitHub describes the workflow scope as the ability to add and update workflow files. Add it to the classic token, or edit those files by hand.',
    },
  ],
  links: [
    {
      label: 'Managing your personal access tokens',
      url: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens',
    },
    {
      label: 'Permissions required for fine-grained personal access tokens',
      url: 'https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens',
    },
    {
      label: 'Scopes for OAuth apps and classic tokens',
      url: 'https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps',
    },
  ],
  checkedOn: CHECKED_ON,
};

export const credentialGuides: Record<CredentialKind, CredentialGuide> = {
  app_store_connect: appStoreConnect,
  google_play: googlePlay,
  github_app: githubApp,
  github_token: githubToken,
};

export function guideFor(kind: CredentialKind): CredentialGuide {
  return credentialGuides[kind];
}
