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
      body: "In that project, find the Google Play Android Developer API in the API library and click Enable. Google's docs call it the Google Play Developer API.",
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

const translateGoogle: CredentialGuide = {
  summary:
    'Lets the tool translate customer reviews with the Cloud Translation API (Basic edition, v2) using an API key. The review text is sent to Google.',
  prerequisites: [
    'A Google Cloud project with billing turned on. Google bills per translated character after a monthly free amount.',
    'Permission to enable APIs and create API keys in that project.',
    'A decision that sending customer review text to Google is acceptable for your privacy policy.',
  ],
  steps: [
    {
      title: 'Open the Google Cloud console',
      body: 'Sign in, then pick or create the project that should pay for translations.',
      link: { label: 'Google Cloud console', url: 'https://console.cloud.google.com/' },
    },
    {
      title: 'Check billing',
      body: 'Make sure the project is linked to a billing account. Google lists the first 500,000 characters each month as free on its pricing page.',
      link: {
        label: 'Cloud Translation pricing',
        url: 'https://cloud.google.com/translate/pricing',
      },
    },
    {
      title: 'Enable the Cloud Translation API',
      body: 'Open APIs and Services, then Library, search for Cloud Translation API and select Enable.',
      link: {
        label: 'Cloud Translation API in the library',
        url: 'https://console.cloud.google.com/apis/library/translate.googleapis.com',
      },
    },
    {
      title: 'Create an API key',
      body: 'Open APIs and Services, then Credentials. Select Create credentials, then API key.',
      link: {
        label: 'Google: Use API keys',
        url: 'https://docs.cloud.google.com/docs/authentication/api-keys-use',
      },
    },
    {
      title: 'Set restrictions on the key',
      body: 'Under API restrictions, choose Restrict key and select only Cloud Translation API. If you restrict by address, use the address of this server, because it makes the calls.',
    },
    {
      title: 'Copy the key',
      body: 'Copy the key value and enter it in the form. This tool sends it in the request to Google and never shows it again.',
    },
    {
      title: 'Set a budget alert',
      body: 'Create a budget alert in Billing so an unexpected volume is noticed. This tool also has its own daily character budget under Settings.',
    },
  ],
  permissions: [
    'The key needs access to the Cloud Translation API only. Restrict it to that API.',
    'The tool sends the review text and the target language. It sends nothing else about your apps.',
    'Google counts every character including spaces. The Basic edition accepts at most 100,000 bytes per request, and this tool sends far less.',
  ],
  troubleshooting: [
    {
      problem: 'The test says the API key is not valid.',
      fix: 'The key was copied with extra characters, deleted, or restricted to another API. Create a new key and restrict it to Cloud Translation API.',
    },
    {
      problem: 'Google answers 403 and says the API has not been used or is disabled.',
      fix: 'Enable the Cloud Translation API in the project that owns the key, and wait a few minutes.',
    },
    {
      problem: 'Google answers 403 with a daily limit or a user rate limit message.',
      fix: 'A quota was reached. Wait for it to reset or raise the quota in the Cloud console. This tool shows it as a quota or rate limit problem.',
    },
    {
      problem: 'Requests are refused because of the application restriction on the key.',
      fix: 'A website (referrer) restriction cannot work for server calls. Use an address restriction for this server, or no application restriction with the API restriction kept.',
    },
    {
      problem: 'The target language is refused.',
      fix: 'Pick a language Google supports. Region variants such as pt-BR or zh-Hant are mapped to Google codes by this tool.',
    },
  ],
  links: [
    {
      label: 'Cloud Translation Basic: translate method',
      url: 'https://docs.cloud.google.com/translate/docs/reference/rest/v2/translate',
    },
    { label: 'Quotas and limits', url: 'https://docs.cloud.google.com/translate/quotas' },
    { label: 'Pricing', url: 'https://cloud.google.com/translate/pricing' },
    { label: 'Supported languages', url: 'https://docs.cloud.google.com/translate/docs/languages' },
  ],
  checkedOn: CHECKED_ON,
};

const translateDeepl: CredentialGuide = {
  summary:
    'Lets the tool translate customer reviews with the DeepL API. The review text is sent to DeepL. A Free plan key and a Pro key both work.',
  prerequisites: [
    'A DeepL account with an API plan (API Free or API Pro). The website translator plans are separate and have no API key.',
    'A decision that sending customer review text to DeepL is acceptable for your privacy policy.',
  ],
  steps: [
    {
      title: 'Open the DeepL API page',
      body: 'Sign in to your DeepL account or create one, then open the API section of the account.',
      link: {
        label: 'DeepL: Authentication',
        url: 'https://developers.deepl.com/docs/getting-started/auth',
      },
    },
    {
      title: 'Choose a plan',
      body: 'Choose API Free or API Pro. Free keys end with :fx and use the api-free.deepl.com address, Pro keys use api.deepl.com.',
    },
    {
      title: 'Create or open a key',
      body: 'In the API Keys tab of your account, create a key or open the one that exists.',
      link: {
        label: 'DeepL: Getting started',
        url: 'https://developers.deepl.com/docs/getting-started/quickstart',
      },
    },
    {
      title: 'Copy the key',
      body: 'Copy the whole key including the :fx ending for a Free plan. The tool picks the Free or Pro address from that ending.',
    },
    {
      title: 'Enter the key',
      body: 'Enter the key in the form on this page, then use the test button. A successful test translates one short word.',
    },
  ],
  permissions: [
    'A DeepL API key can translate text and use every feature of the plan. There is no narrower key, so keep it private.',
    'The tool sends the review text and the target language only.',
    'DeepL bills the characters it translates. The Free plan has a monthly character limit; Pro is billed by usage.',
  ],
  troubleshooting: [
    {
      problem: 'DeepL answers 403.',
      fix: 'The key is wrong, or it is a Pro key used on the Free address or the other way round. Copy the key again; a Free key must end with :fx.',
    },
    {
      problem: 'DeepL answers 456.',
      fix: 'The plan quota is used up. Wait for the next period or raise the plan. This tool shows it as a quota problem.',
    },
    {
      problem: 'DeepL answers 429.',
      fix: 'Too many requests. This tool tells you to wait and try again; lower the volume if it keeps happening.',
    },
    {
      problem: 'The target language is refused.',
      fix: 'DeepL supports fewer languages than Google. This tool maps regional tags such as pt-BR and zh-Hant to DeepL codes where DeepL has one.',
    },
  ],
  links: [
    {
      label: 'DeepL: Translate text',
      url: 'https://developers.deepl.com/api-reference/translate/request-translation',
    },
    {
      label: 'DeepL: Authentication',
      url: 'https://developers.deepl.com/docs/getting-started/auth',
    },
    {
      label: 'DeepL: Supported languages',
      url: 'https://developers.deepl.com/docs/getting-started/supported-languages',
    },
  ],
  checkedOn: CHECKED_ON,
};

const translateAzure: CredentialGuide = {
  summary:
    'Lets the tool translate customer reviews with Microsoft Translator in Azure AI services. The review text is sent to Microsoft.',
  prerequisites: [
    'An Azure subscription where you may create resources.',
    'A decision that sending customer review text to Microsoft is acceptable for your privacy policy.',
  ],
  steps: [
    {
      title: 'Open the Azure portal',
      body: 'Sign in and select the subscription that should pay for translations.',
      link: { label: 'Azure portal', url: 'https://portal.azure.com/' },
    },
    {
      title: 'Create a Translator resource',
      body: 'Create a Translator resource in Azure AI services. Choose a region and a pricing tier; the free tier has an hourly character limit.',
      link: {
        label: 'Microsoft: Translator service limits',
        url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits',
      },
    },
    {
      title: 'Open Keys and Endpoint',
      body: 'Open the resource, then Keys and Endpoint. Note the region shown there.',
    },
    {
      title: 'Copy a key',
      body: 'Copy Key 1 or Key 2. Both work, which lets you rotate one while the other is in use.',
    },
    {
      title: 'Enter the key and region',
      body: 'Enter the key. Enter the region for a regional or multi-service resource, and leave it empty for a global resource.',
      link: {
        label: 'Microsoft: Translator authentication',
        url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication',
      },
    },
  ],
  permissions: [
    'A resource key can translate text and use every feature of the resource. Keep it private and rotate it if it leaks.',
    'The tool sends the review text and the target language only, to the public Translator address.',
    'A resource that uses a virtual network needs its own address, which this tool does not support.',
  ],
  troubleshooting: [
    {
      problem: 'Microsoft answers 401.',
      fix: 'The key is wrong or the region does not match a regional or multi-service resource. Copy the key and the region again from Keys and Endpoint.',
    },
    {
      problem: 'Microsoft answers 403.',
      fix: 'The subscription may be out of free translations or the resource is disabled. Check the resource in the portal.',
    },
    {
      problem: 'Microsoft answers 429.',
      fix: 'The request limit was reached. This tool tells you to wait and try again.',
    },
    {
      problem: 'The test fails on a resource inside a virtual network.',
      fix: 'The global address does not work for such a resource. Use a resource that allows public network access.',
    },
  ],
  links: [
    {
      label: 'Translator: Translate method',
      url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/translate',
    },
    {
      label: 'Translator: Authentication',
      url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication',
    },
    {
      label: 'Translator: Service limits',
      url: 'https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits',
    },
  ],
  checkedOn: CHECKED_ON,
};

const translateLibretranslate: CredentialGuide = {
  summary:
    'Lets the tool translate customer reviews with a LibreTranslate server you run or rent. The server address is a workspace setting; this credential is only the API key, and only when the server asks for one.',
  prerequisites: [
    'A LibreTranslate server that this server can reach, started by you or hosted by someone else.',
    'The address of the server (https, or http on this same machine). An address on your own network needs MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true on this server.',
  ],
  steps: [
    {
      title: 'Choose where it runs',
      body: 'Run LibreTranslate yourself, for example with Docker, or use a hosted one. Review text goes to whichever you choose.',
      link: { label: 'LibreTranslate documentation', url: 'https://docs.libretranslate.com/' },
    },
    {
      title: 'Start the server',
      body: 'Follow the project instructions to start it and download the language models you need.',
      link: {
        label: 'LibreTranslate on GitHub',
        url: 'https://github.com/LibreTranslate/LibreTranslate',
      },
    },
    {
      title: 'Check whether it needs a key',
      body: 'A server started without API key checking needs no credential here. A hosted server or one started with API keys does.',
    },
    {
      title: 'Create a key',
      body: 'If a key is needed, create one the way that server describes, then copy it.',
    },
    {
      title: 'Enter the key',
      body: 'Enter the key in the form. Then open Settings, Translation, choose LibreTranslate and enter the server address.',
    },
    {
      title: 'Wait for the test',
      body: 'Use the test button in Settings. It translates one short word and says whether the address, the key and the languages work.',
    },
  ],
  permissions: [
    'The key can use the translation service of that server. Keep it private.',
    'The tool sends the review text and the target language to the address you entered, and nothing else.',
    'This server refuses addresses with a user name or password in them, addresses on a private network unless MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true, and cloud metadata addresses always.',
  ],
  troubleshooting: [
    {
      problem: 'The address is refused as private or not allowed.',
      fix: 'A server on your own network is refused by default. Set MRM_TRANSLATE_ALLOW_PRIVATE_URLS=true on this server only if you trust everyone who can change settings.',
    },
    {
      problem: 'The server answers 403.',
      fix: 'The API key is missing or wrong, or the client was blocked by its rate limiting. Add a credential of this kind with the right key.',
    },
    {
      problem: 'The server answers 429.',
      fix: 'Its rate limit was reached. This tool tells you to wait and try again; a self-hosted server can raise the limit.',
    },
    {
      problem: 'A language is reported as not supported.',
      fix: 'The server has not installed the model for that language pair. Install it on the server or pick another target.',
    },
    {
      problem: 'The server takes too long.',
      fix: 'The first request after a start can be slow. Try the test again, or give the server more resources.',
    },
  ],
  links: [
    { label: 'LibreTranslate documentation', url: 'https://docs.libretranslate.com/' },
    { label: 'LibreTranslate on GitHub', url: 'https://github.com/LibreTranslate/LibreTranslate' },
  ],
  checkedOn: CHECKED_ON,
};

const aiAnthropic: CredentialGuide = {
  summary:
    'Lets the tool send the data listed for an AI task to the Anthropic API and read back a structured proposal. It cannot publish, send or change anything in a store: a person accepts every proposal.',
  prerequisites: [
    'An Anthropic account with a billing method, and an API key from its console.',
    'AI assistance turned on for this server (MRM_AI_ENABLED=true) and for the workspace, by an admin.',
  ],
  steps: [
    {
      title: 'Open your Anthropic account',
      body: 'Sign in to the Anthropic console and check that billing is set up for the workspace you want to use.',
      link: {
        label: 'Claude API overview',
        url: 'https://platform.claude.com/docs/en/api/overview',
      },
    },
    {
      title: 'Create a key',
      body: 'Create an API key only for this tool, so you can revoke it without touching anything else.',
    },
    {
      title: 'Set a spending limit',
      body: 'Set a spending limit with Anthropic as well. The monthly token budget in AI settings is a second, separate limit.',
    },
    {
      title: 'Enter the key',
      body: 'Enter the key in the form. Then open AI settings, choose Anthropic and enter the model name you want to use.',
    },
    {
      title: 'Choose a model',
      body: 'Use a model name from the Anthropic model list. No model is chosen for you, so an old name never goes stale.',
    },
    {
      title: 'Wait for the test',
      body: 'Use the test button in AI settings. It sends one fixed request without any of your data and says whether the key and the model work.',
    },
  ],
  permissions: [
    'The key can spend money on your Anthropic account. Keep it private and revoke it if it leaks.',
    'The tool sends only the data listed for a task before you run it, never credentials and never reviewer names.',
    'Nothing the model writes is acted on by itself: it becomes a proposal that a person accepts or dismisses.',
  ],
  troubleshooting: [
    {
      problem: 'The test says the key was refused.',
      fix: 'The key is wrong, revoked or from another workspace. Create a new key and enter it again.',
    },
    {
      problem: 'The test says the provider is limiting requests.',
      fix: 'A rate limit or a spending cap was reached. Wait, or raise the limit in the Anthropic console.',
    },
    {
      problem: 'The test says the provider could not be reached.',
      fix: 'Check that this server can reach api.anthropic.com over https, and that the model name exists on your account.',
    },
    {
      problem: 'A task says the answer could not be used.',
      fix: 'The model did not return what the task needs, or ran out of room. Try again, or choose a more capable model.',
    },
  ],
  links: [
    { label: 'Claude API overview', url: 'https://platform.claude.com/docs/en/api/overview' },
    { label: 'Claude API errors', url: 'https://platform.claude.com/docs/en/api/errors' },
  ],
  checkedOn: CHECKED_ON,
};

const aiOpenai: CredentialGuide = {
  summary:
    'Lets the tool send the data listed for an AI task to the OpenAI API and read back a structured proposal. It cannot publish, send or change anything in a store: a person accepts every proposal.',
  prerequisites: [
    'An OpenAI account with a billing method, and an API key.',
    'AI assistance turned on for this server (MRM_AI_ENABLED=true) and for the workspace, by an admin.',
  ],
  steps: [
    {
      title: 'Open your OpenAI account',
      body: 'Sign in to the OpenAI platform and check that billing is set up for the project you want to use.',
      link: {
        label: 'OpenAI structured outputs',
        url: 'https://developers.openai.com/api/docs/guides/structured-outputs',
      },
    },
    {
      title: 'Create a key',
      body: 'Create an API key only for this tool, in a project of its own, so you can revoke it without touching anything else.',
    },
    {
      title: 'Set a spending limit',
      body: 'Set a project budget with OpenAI as well. The monthly token budget in AI settings is a second, separate limit.',
    },
    {
      title: 'Enter the key',
      body: 'Enter the key in the form. Then open AI settings, choose OpenAI and enter the model name you want to use.',
    },
    {
      title: 'Choose a model',
      body: 'Use a model that supports structured outputs. No model is chosen for you, so an old name never goes stale.',
    },
    {
      title: 'Wait for the test',
      body: 'Use the test button in AI settings. It sends one fixed request without any of your data and says whether the key and the model work.',
    },
  ],
  permissions: [
    'The key can spend money on your OpenAI account. Keep it private and revoke it if it leaks.',
    'The tool sends only the data listed for a task before you run it, never credentials and never reviewer names.',
    'Nothing the model writes is acted on by itself: it becomes a proposal that a person accepts or dismisses.',
  ],
  troubleshooting: [
    {
      problem: 'The test says the key was refused.',
      fix: 'The key is wrong, revoked or belongs to another project. Create a new key and enter it again.',
    },
    {
      problem: 'The test says the provider is limiting requests.',
      fix: 'A rate limit or a budget was reached. Wait, or raise the limit in your OpenAI project.',
    },
    {
      problem: 'The test says the provider could not be reached.',
      fix: 'Check that this server can reach api.openai.com over https, and that the model name exists in your project.',
    },
    {
      problem: 'A task says the answer could not be used.',
      fix: 'The model did not return what the task needs, or ran out of room. Try again, or choose a more capable model.',
    },
  ],
  links: [
    {
      label: 'OpenAI structured outputs',
      url: 'https://developers.openai.com/api/docs/guides/structured-outputs',
    },
    {
      label: 'OpenAI API reference',
      url: 'https://developers.openai.com/api/reference/resources/responses/methods/create',
    },
  ],
  checkedOn: CHECKED_ON,
};

const aiOpenaiCompatible: CredentialGuide = {
  summary:
    'Lets the tool use a model you run yourself, or a gateway, that speaks the OpenAI chat protocol. The server address is a workspace setting; this credential is only the API key, and only when the server asks for one.',
  prerequisites: [
    'A model server this server can reach, for example Ollama, LM Studio or vLLM, or a hosted gateway.',
    'The address of the server, ending in /v1. A server on your own network needs MRM_AI_ALLOW_PRIVATE_URLS=true on this server, and plain http only works to this same machine.',
  ],
  steps: [
    {
      title: 'Choose where it runs',
      body: 'Run a model server yourself or use a hosted one. The data of a task goes to whichever you choose.',
      link: {
        label: 'Ollama OpenAI compatibility',
        url: 'https://docs.ollama.com/api/openai-compatibility',
      },
    },
    {
      title: 'Start the server',
      body: 'Follow the project instructions to start it and load a model that can follow a JSON schema.',
      link: {
        label: 'LM Studio structured output',
        url: 'https://lmstudio.ai/docs/developer/openai-compat/structured-output',
      },
    },
    {
      title: 'Check whether it needs a key',
      body: 'A local server usually needs no key, so no credential is needed. A hosted gateway or a server started with a key does.',
    },
    {
      title: 'Create a key',
      body: 'If a key is needed, create one the way that server describes, then copy it.',
    },
    {
      title: 'Enter the address',
      body: 'Open AI settings, choose the OpenAI compatible server, enter the address and the model name exactly as the server lists it.',
    },
    {
      title: 'Wait for the test',
      body: 'Use the test button in AI settings. It sends one fixed request without any of your data and says whether the address, the key and the model work.',
    },
  ],
  permissions: [
    'The key can use that server. Keep it private.',
    'The tool sends only the data listed for a task before you run it, and nothing else, to the address you entered.',
    'This server refuses addresses with a user name or password in them, addresses on a private network unless MRM_AI_ALLOW_PRIVATE_URLS=true, and cloud metadata addresses always.',
  ],
  troubleshooting: [
    {
      problem: 'The address is refused as private or not allowed.',
      fix: 'A server on your own network is refused by default. Set MRM_AI_ALLOW_PRIVATE_URLS=true on this server only if you trust everyone who can change settings.',
    },
    {
      problem: 'The test says the key was refused.',
      fix: 'The server wants a key. Add a credential of this kind with the right key.',
    },
    {
      problem: 'A task says the answer could not be used.',
      fix: 'Small models often ignore a schema. Try a larger model, or one that supports structured output.',
    },
    {
      problem: 'The server takes too long.',
      fix: 'The first request after a start loads the model and can be slow. Try again, or give the server more memory.',
    },
  ],
  links: [
    {
      label: 'Ollama OpenAI compatibility',
      url: 'https://docs.ollama.com/api/openai-compatibility',
    },
    {
      label: 'LM Studio structured output',
      url: 'https://lmstudio.ai/docs/developer/openai-compat/structured-output',
    },
    {
      label: 'vLLM structured outputs',
      url: 'https://docs.vllm.ai/en/latest/features/structured_outputs.html',
    },
  ],
  checkedOn: CHECKED_ON,
};

const expo: CredentialGuide = {
  summary:
    'Lets the tool read your Expo Application Services (EAS) projects with an access token. A robot user keeps the token apart from any one person.',
  prerequisites: [
    'An Expo account (personal or organization) that owns the EAS project. Expo lets Admins manage programmatic access, so use an Admin or Owner to create the token.',
    'A secure place for the token, because Expo shows it only once.',
  ],
  steps: [
    {
      title: 'Open the Expo dashboard',
      body: 'Sign in at expo.dev with an account that is an Admin or Owner of the Expo account that owns your project.',
      link: { label: 'Expo: Programmatic access', url: 'https://docs.expo.dev/accounts/programmatic-access/' },
    },
    {
      title: 'Open Access tokens',
      body: 'Open the settings of that account and select Access tokens. For an organization the page is expo.dev/accounts/ followed by the account name, then settings/access-tokens.',
    },
    {
      title: 'Create a robot user',
      body: 'Create a robot user and name it after this tool. A robot cannot sign in or own projects, and it authenticates only with access tokens.',
    },
    {
      title: 'Choose the role',
      body: 'Give the robot the Developer role. You can change it later with Edit robot.',
      link: { label: 'Expo: Account types and roles', url: 'https://docs.expo.dev/accounts/account-types/' },
    },
    {
      title: 'Create the token',
      body: 'Create a token for the robot and copy it right away. Expo does not show it again.',
    },
    {
      title: 'Enter the token here',
      body: 'Paste the token into the form, then use Test connection. It asks Expo who the token belongs to and which accounts it can see.',
    },
  ],
  permissions: [
    'Use a robot user with the Developer role. Expo describes Developer as able to create projects, make builds, release updates and manage credentials, so the token can do all of that on your account.',
    'The tool reads project details with the token. Treat the token as able to do everything its role can.',
    'A personal access token also works, but it acts as you and can reach every account you belong to unless you limit it.',
    'Expo documents how to revoke a token (delete it on the Access tokens page) and does not describe an expiry date. Rotate the token when someone who knew it leaves.',
  ],
  troubleshooting: [
    {
      problem: 'The test says Expo did not accept the token.',
      fix: 'The token was copied incompletely, or it was deleted. Create a new token for the robot and enter it again.',
    },
    {
      problem: 'The test says the token may not do this.',
      fix: 'Check the robot role and that the robot belongs to the account that owns the project. Edit the robot in Access tokens to change its role.',
    },
    {
      problem: 'Linking a project says Expo has no such project.',
      fix: 'The project belongs to another account, or the token cannot see it. Use a token from the owning account, and check the name as account and slug or the project id in app.json.',
    },
    {
      problem: 'The test shows no accounts, or fewer than you expect.',
      fix: 'A personal token may be limited to some accounts. Create a new token without the limit, or use a robot user on the right account.',
    },
    {
      problem: 'The test says Expo could not be reached.',
      fix: 'Check that this server can reach api.expo.dev over https, and that a proxy, if you use one, allows it.',
    },
  ],
  links: [
    { label: 'Expo: Programmatic access', url: 'https://docs.expo.dev/accounts/programmatic-access/' },
    { label: 'Expo: Account types and roles', url: 'https://docs.expo.dev/accounts/account-types/' },
    { label: 'Expo: Access tokens page', url: 'https://expo.dev/settings/access-tokens' },
  ],
  checkedOn: '2026-11-20',
};

export const credentialGuides: Record<CredentialKind, CredentialGuide> = {
  app_store_connect: appStoreConnect,
  google_play: googlePlay,
  github_app: githubApp,
  github_token: githubToken,
  translate_google: translateGoogle,
  translate_deepl: translateDeepl,
  translate_azure: translateAzure,
  translate_libretranslate: translateLibretranslate,
  ai_anthropic: aiAnthropic,
  ai_openai: aiOpenai,
  ai_openai_compatible: aiOpenaiCompatible,
  expo,
};

export function guideFor(kind: CredentialKind): CredentialGuide {
  return credentialGuides[kind];
}
