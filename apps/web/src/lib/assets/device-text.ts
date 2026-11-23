import { type AssetKind, kindHasDevice } from '@kiln/core';
import { t } from '../i18n/t.ts';

/**
 * The device part of a set title, as shown. `@kiln/core` gives the label of a known device class and an empty string
 * for no class. Kinds without a device dimension (icon, feature graphic, promo graphic, TV banner) get no suffix at all;
 * a screenshot or preview set whose device could not be recognised says so (translated here, not in core).
 */
export function deviceText(kind: AssetKind, device: string | null, label: string): string {
  if (!kindHasDevice(kind)) return '';
  return device === null ? t('assets:device.unrecognised') : label;
}
