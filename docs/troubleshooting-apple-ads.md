# Troubleshooting Apple Ads

Read only: Kiln reads campaign, search term and keyword reports of your own Apple Ads account ([ADR 0058](adr/0058-apple-ads.md), [api/apple-ads](api/apple-ads.md)). **Test connection** under Credentials signs in and lists the ad accounts; nothing is stored by the test. Kiln has not been run against a real account, so the messages below follow Apple's documentation (UNVERIFIED).

| You see | Meaning | Do |
| ------- | ------- | -- |
| "The private key could not be read" (`ads.invalidKey`) | The text is not a P-256 PEM private key. | Paste the whole `private-key.pem`, from `-----BEGIN EC PRIVATE KEY-----` to `-----END EC PRIVATE KEY-----`. Make it with `openssl ecparam -genkey -name prime256v1 -noout -out private-key.pem`. |
| "Apple did not accept the key" (`ads.auth`) | The public key of this private key is not saved in Apple Ads, or an id is wrong, or the clock of this server is far off. | In Apple Ads, Account Settings, API, check the public key is saved and copy the client id, team id and key id again. Check the server time. |
| "This user may not read the ad account" (`ads.forbidden`) | The API user has no read role on the account. | Give it **API Account Read Only** (User Management). |
| "It sees no ad account" (`ads.noAccount`) | The API user was not invited to any account. | Invite it in Apple Ads, Account Settings, User Management. |
| "Could not reach Apple Ads" (`ads.network`) | No route to `appleid.apple.com` or `api.ads.apple.com`. | Allow both hosts (and a proxy if needed). |
| "Apple Ads asked to slow down" (`ads.rateLimited`) | Apple answered `429`. | Wait a minute; the sync keeps its stored rows and does not count it as a failure. |
| Overview says there is no data | The sync never ran, the range has no days, or no campaign promotes the linked app. | Press Sync. In Account, check the warning `no_campaign` and the Apple id of the app (the number after `id` in its App Store address). |
| "Some days were left out" (`currency_mismatch`) | Apple reported a currency other than the ad account's. | Nothing is mixed in. Check the currency of the account. |
| Few or no search terms | Apple hides terms with very few impressions. | Normal for small campaigns. |
