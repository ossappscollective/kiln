import type { Draft } from '../../operations/shared.ts';

/**
 * Every operation of the EAS module, joined from the files of its features (each exports an array of `Draft`). Add yours with one
 * import and one spread; `operations/registry.ts` reads `easOperations` only.
 */
export const easOperations: Draft[] = [];
