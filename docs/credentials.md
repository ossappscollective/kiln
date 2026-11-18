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

## Customer reviews (what the same credentials need)

Reading reviews uses the **same** App Store Connect key and Google Play service account as the
app sync; there is no extra credential. Reading never calls the endpoints that reply to a review.
Which role or permission a read needs was **not verified against a real account**. Replying (below)
needs more and is off unless the server turns it on:

- **App Store Connect.** `GET /v1/apps/{id}/customerReviews` is documented at
  https://developer.apple.com/documentation/appstoreconnectapi/get-v1-apps-_id_-customerreviews
  and that page names no required role. If a key is refused with `store_forbidden`, use a team key
  with a role that can see the app's customer reviews. Keep the lowest role that works. Responding
  needs a role that may respond (see [Replying to reviews](#replying-to-reviews)).
- **Google Play.** `reviews.list` is documented at
  https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/list and the guide
  https://developers.google.com/android-publisher/reply-to-reviews names the permission **Reply to
  reviews** for the review calls. Play Console's read-only permission is **View app information and
  download bulk reports**. Whether that alone is enough to list reviews is **unverified**. If the
  read-only permission is refused (`store_forbidden`), the service account needs **Reply to
  reviews**, which in Play Console also lets that account answer reviews through the API. Grant it
  only for the apps whose reviews you want, and treat the key accordingly.
- The Google Cloud Storage statistics export and the Play Developer Reporting API are **not used**
  (see [api/reviews](api/reviews.md#what-each-store-provides) for why).

## Replying to reviews

Replying is a **write**: the text is published publicly in the store. It is **off** unless the server
runs with `MRM_REVIEW_REPLY_ENABLED=true` ([deployment](deployment.md#replying-to-reviews-a-store-write-off-by-default)),
and only an owner or admin of this workspace can send. It uses the **same credential** as reading
reviews: a key that may reply can also read them, and the key itself could answer reviews outside
this tool. Issue it only for the apps that need it.

- **Google Play.** The service account needs the Play Console permission **Reply to reviews**
  (named in https://developers.google.com/android-publisher/reply-to-reviews). `reviews.reply` is
  documented at https://developers.google.com/android-publisher/api-ref/rest/v3/reviews/reply with
  the scope `https://www.googleapis.com/auth/androidpublisher`. `replyText` is at most 350
  characters, a new reply replaces the old one, replies are public, and the quota is 2000 reply
  requests a day per app. That permission also covers listing reviews, so one account does both
  (it is **unverified** whether the narrower read-only permission lists reviews; see above). Only
  reviews of the last week can be read back; this tool needs the read-back to settle an unknown outcome.
- **App Store Connect.** `POST /v1/customerReviewResponses` is documented at
  https://developer.apple.com/documentation/appstoreconnectapi/post-v1-customerreviewresponses (it
  creates a response or overwrites the existing one; the state is `PENDING_PUBLISH` until Apple
  publishes it). Apple's help page says the **Account Holder, Admin and Customer Support** roles may respond to
  reviews in App Store Connect
  (https://developer.apple.com/help/app-store-connect/monitor-ratings-and-reviews/respond-to-reviews).
  Which **API key** role may do it is **unverified**: a developer forum thread says Customer Support
  cannot be chosen for a team key, so assume **Admin** is needed, and one report (HTTP 405 for some
  keys, https://developer.apple.com/forums/thread/727332) is why a 405 is shown as "the key may not
  do this". The success status and the length limit are not stated on the page checked; this tool
  caps a reply at 5000 characters on its own.
- If a send says `store_forbidden`, the key lacks the permission: grant it, or answer in the store's
  own console and mark the review "Replied in store console".

## Changing a rollout (what the same credentials need)

Only when the server runs with `MRM_STORE_ROLLOUT_ENABLED=true` ([deployment](deployment.md#changing-a-store-rollout-a-store-write-off-by-default)).
The same credential is used; no new one is needed, but it must be allowed to release the app.

- **Google Play:** the service account must be allowed to manage releases of the app in Play Console
  (UNVERIFIED which exact permission an `edits.tracks.update` and `edits.commit` need; the account
  that only reads needs less). The changes go through the edits API, documented at
  https://developers.google.com/android-publisher/tracks.
- **App Store Connect:** the key needs a role allowed to manage the version's phased release (App
  Manager or Admin is assumed; UNVERIFIED). The app must have been synced once (its App Store id is
  needed).
- If a change says `store_forbidden`, the key lacks the permission; the rollout can still be changed
  in the store's own console.

## Store listing sections (what the same credentials need)

The listing sections ([api/listing](api/listing.md#sections-beyond-the-texts): categories, age rating,
privacy choices URL, app details, screenshot and preview counts, Play release notes) use the **same**
App Store Connect key and Google Play service account as the app sync. There is no extra credential
and no new kind of access: every call is a read. Which role or permission is enough was **not verified
against a real account**:

- **App Store Connect.** The new reads are `GET` of the app info with its categories and age rating
  declaration, and of the screenshot and preview sets of a version localization (endpoints linked in
  the listing doc). They need a key that can see the app's metadata; the role is the one the sync's
  listing read already needs, and this tool does not ask for more. The **review detail** (contact
  person, phone number, demo account) is never requested, so the key does not need to see it. If one
  of these reads is refused (HTTP 403) the section is left out and the Listing tab shows a warning,
  while the rest of the listing and the release sync keep working; raise the role only as far as you
  need.
- **Google Play.** The new reads (`edits.details.get`, `edits.images.list`, `edits.tracks`) happen
  inside the **same edit** the listing read already opens and deletes (never committed), so they need
  the same app permissions as that read. Play Console's read-only permission is **View app
  information and download bulk reports**; whether it is enough to open an edit at all is
  **unverified** (the Play guide describes edits as the way to change an app, and this tool never
  changes one). If the account is refused, grant the permission that lets it manage the store
  listing for that app only, and treat the key accordingly: the key itself could do more than this
  server does. The contact phone number in the app details is never read.
- Nothing here lets this tool change a store: no upload, no delete, no commit of an edit.

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
