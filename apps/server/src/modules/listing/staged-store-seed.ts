import { createHash } from 'node:crypto';
import { ASSET_SYNC_LIMITS, type AssetSlot, sniffImageFormat } from '@kiln/core';
import type { ManagedApp } from '../../services/apps.ts';
import { type Failure, failure } from '../../services/repositories.ts';
import { gitBlobOid } from '../publish/staged-asset-blobs.ts';
import { type SetEntry, type SetSeed, safeUploadName, uploadPathOf } from '../publish/staged-sets.ts';
import { getStoreImages, type StoreImagesContext, storeImageBytes } from './store-images.ts';

import { coded } from '../../i18n/problem.ts';
/**
 * The start of an edit made from the store's side (docs/api/staged-changes.md): a set that is not staged yet is the images the
 * store holds for it. Each is downloaded once (the same allow listed CDN fetch as a pull, one after the other) and kept as a
 * staged upload, so a push, which replaces the store's whole set, keeps the images the person did not touch. A set the store
 * does not hold is new (no entries). A WebP or GIF cannot be pushed, so such a set is refused with the reason.
 */
export function storeSeed(
  ctx: StoreImagesContext,
  input: {
    workspaceId: string;
    app: ManagedApp;
    locale: string;
    slot: AssetSlot;
    actor: { type: 'user' | 'token' | 'system'; id: string };
  },
): SetSeed {
  return async (): Promise<SetEntry[] | Failure> => {
    const read = await getStoreImages(ctx, {
      workspaceId: input.workspaceId,
      app: input.app,
      actor: input.actor,
    });
    if (!read.ok) return read;
    const sets = read.view.sets.filter(
      (s) =>
        s.locale === input.locale && s.kind === input.slot.kind && s.device === input.slot.device,
    );
    const files = sets
      .flatMap((s) => s.files)
      .sort((a, b) => a.position - b.position);
    const entries: SetEntry[] = [];
    for (const file of files) {
      const got = await storeImageBytes(ctx, {
        workspaceId: input.workspaceId,
        appId: input.app.id,
        ref: file.ref,
        maxBytes: ASSET_SYNC_LIMITS.maxUploadBytes,
      });
      if (!got.ok) return got;
      // Google gives the SHA-256 of the original: bytes that do not match it are a rendition, never staged as the store's file.
      if (
        file.checksumKind === 'sha256' &&
        file.checksum !== null &&
        file.checksum.length === 64 &&
        createHash('sha256').update(got.image.bytes).digest('hex') !== file.checksum.toLowerCase()
      )
        return failure(
          422,
          'checksum_mismatch',
          `Image ${file.position} of this set does not match the checksum the store gave, so it was not taken. Read the store again.`,
          coded('staged.storeImageMismatch', { position: file.position }),
        );
      const format = sniffImageFormat(got.image.bytes);
      if (format !== 'png' && format !== 'jpeg')
        return failure(
          422,
          'asset_not_pushable',
          `The store holds image ${file.position} of this set as ${format ?? 'an unknown format'}, which cannot be pushed, so the set cannot be edited here.`,
          coded('staged.storeImageFormat', { position: file.position }),
        );
      const oid = gitBlobOid(got.image.bytes);
      entries.push({
        source: 'local',
        valueHash: oid,
        assetPath: uploadPathOf(oid, safeUploadName(file.name ?? undefined, format)),
        assetCommit: null,
        bytes: got.image.bytes.length,
        width: got.image.width,
        height: got.image.height,
        format,
        alpha: got.image.hasAlpha,
        blob: {
          bytes: got.image.bytes,
          mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
        },
      });
    }
    return entries;
  };
}
