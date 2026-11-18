/** Invitation links look like `<origin>/#/invite/<token>`. The token never reaches a server log. */
export const inviteHash = (token: string) => `#/invite/${encodeURIComponent(token)}`;

export const inviteLink = (origin: string, token: string) => `${origin}/${inviteHash(token)}`;

/** The token in a location hash, or null when the hash is not an invitation link. */
export function tokenFromHash(hash: string): string | null {
  const match = /^#\/invite\/([^/?#]+)\/?$/.exec(hash);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
