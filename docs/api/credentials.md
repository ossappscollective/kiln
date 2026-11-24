# Credentials (list)

`GET /api/workspaces/:workspaceId/credentials` needs the `credentials.read` right (member and above). It returns
metadata and the NON-SECRET identifiers of each credential. A secret (private key, token, API key, JSON key body)
is never returned by any route.

```json
{
  "credentials": [
    {
      "id": "…",
      "kind": "app_store_connect",
      "label": "Acme ASC key",
      "createdAt": 1760000000000,
      "rotatedAt": null,
      "lastTest": null,
      "identifiers": [
        {
          "key": "issuerId",
          "label": "Issuer ID",
          "value": "57246542-96fe-1a63-e053-0824d011072a",
          "copyable": true
        },
        { "key": "keyId", "label": "Key ID", "value": "ABC123DEFG", "copyable": true }
      ]
    }
  ]
}
```

`identifiers` is computed on the server from the decrypted payload through an allow-list of field names per kind
(`apps/server/src/services/credential-identifiers.ts`); there is no "everything except the secret" path. A value
that is not shaped like an identifier, or that repeats a secret field, is dropped. Reading the identifiers is not
audited as a use of the secret (nothing secret leaves). `key` is a stable id (the web app translates the label from
it); `label` is an English fallback; `copyable` is false for a descriptive value such as a token type.

| Kind                | Identifiers                                                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `app_store_connect` | `issuerId`, `keyId`                                                                                                                |
| `google_play`       | `clientEmail` (service account e-mail), `projectId`, `serviceKeyId` (the `private_key_id`, an identifier, not the key), `clientId` |
| `github_app`        | `appId`, `installationId`                                                                                                          |
| `github_token`      | `tokenType` (`classic`, `fine_grained`, `oauth`, `user_to_server`, `installation`, from the public prefix)                         |
| `translate_azure`   | `region`                                                                                                                           |
| other kinds         | none (the payload holds only a key or token)                                                                                       |

`POST /credentials` answers with the same `identifiers` for the credential just saved. Replacing the secret changes
what the list shows. The vendor number and the Play reports bucket are not stored on the credential: an app's
effective values and where they come from (`vendorNumberSource`, `bucketSource`) are in the analytics status
([analytics](analytics.md)).
