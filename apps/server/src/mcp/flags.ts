/** The server's own switches for store writes: the same env flags the routes check (docs/adr/0023-mcp-server.md). */
export type McpFlags = {
  reviewReply: boolean;
  storeRollout: boolean;
  storeDraft: boolean;
  storeSubmit: boolean;
  storeRelease: boolean;
  storePublish: boolean;
  internalSharing: boolean;
};

export const FLAG_ENV: Record<keyof McpFlags, string> = {
  reviewReply: 'KILN_REVIEW_REPLY_ENABLED',
  storeRollout: 'KILN_STORE_ROLLOUT_ENABLED',
  storeDraft: 'KILN_STORE_DRAFT_WRITE_ENABLED',
  storeSubmit: 'KILN_STORE_SUBMIT_ENABLED',
  storeRelease: 'KILN_STORE_RELEASE_ENABLED',
  storePublish: 'KILN_STORE_PUBLISH_BATCH_ENABLED',
  internalSharing: 'KILN_PLAY_INTERNAL_SHARING_ENABLED',
};

export const noFlags: McpFlags = {
  reviewReply: false,
  storeRollout: false,
  storeDraft: false,
  storeSubmit: false,
  storeRelease: false,
  storePublish: false,
  internalSharing: false,
};
