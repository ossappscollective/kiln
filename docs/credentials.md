# Getting your credentials

The tool needs a key or token for each service it talks to. This page condenses the guides shown
next to the credential form. The source is `packages/core/src/credential-guides.ts`, and every
vendor page was checked on 2026-11-18. Details that could not be confirmed are listed in
[spikes/credential-guides-unverified.md](spikes/credential-guides-unverified.md); for those, trust
the vendor's own screen over this page.

Keep every key private. Do not commit keys or paste them into chat.

## App Store Connect (team API key)

You need an Account Holder or Admin account. The Account Holder may have to request API access
for the team first.

1. In App Store Connect, open Users and Access, then Integrations, then App Store Connect API.
2. With Team Keys selected, click Generate API Key, name it, and choose an access role.
3. Download the .p8 file. Apple allows this once and keeps no copy.
4. Copy the Key ID from the Active list and the Issuer ID from the top of the page.
5. Enter the Issuer ID, Key ID and the contents of the .p8 file in the form.

Least privilege: use the lowest role that covers your tasks. Team keys cover all apps, and the role
cannot be changed later. If it is lost or leaked, revoke it and generate a new key.

Docs: https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api

## Google Play (service account)

1. In Google Cloud, create or pick a project and enable the Google Play Android Developer API.
2. Create a service account, then add a JSON key on its Keys tab. The file downloads once.
3. In Play Console, open Users and permissions and click Invite new users.
4. Enter the service account email, do not make it an account admin, and grant app permissions for
   only the apps and tasks you need, such as releasing to testing tracks or managing the store
   listing.
5. Paste the JSON file contents into the form.

If you get 401 or 403 right after inviting the account, check the invitation and permissions, then
wait and retry. Google does not document how long this takes.

Docs: https://developers.google.com/android-publisher/getting_started

## GitHub App (recommended for teams)

1. In Settings, Developer settings, GitHub Apps, click New GitHub App. Give it a name and homepage
   URL, and clear the webhook Active checkbox.
2. Set repository permissions: Contents, Pull requests and Actions to Read and write, with
   Metadata read-only.
3. Create the app and copy the App ID.
4. Under Credentials, Key pairs, click New key to download the .pem file.
5. Install the app and select only the repositories the tool needs.
6. Copy the Installation ID, which is the number at the end of the installation settings URL.
   GET /app/installations also lists it.

Docs: https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app

## GitHub personal access token (for trying things out)

1. In Settings, Developer settings, Personal access tokens, choose Fine-grained tokens.
2. Pick the resource owner, a short expiration, and only the repositories the tool needs.
3. Set Contents, Pull requests and Actions to Read and write.
4. Generate the token and copy it right away. An organization may need to approve it first.

GitHub recommends fine-grained tokens over classic ones. A classic token needs the repo scope and
reaches every repository you can.

Docs: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
