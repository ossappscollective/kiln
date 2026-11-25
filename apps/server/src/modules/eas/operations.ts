import type { Draft } from '../../operations/shared.ts';
import { easConfigOperations } from './config-operations.ts';
import { easLinkOperations } from './link-operations.ts';
import { easStatusOperations } from './status-operations.ts';
import { easUpdateOperations } from './update-operations.ts';
import { easWorkflowOperations } from './workflows-operations.ts';

/**
 * Every operation of the EAS module, joined from the files of its features (each exports an array of `Draft`). Add yours with one
 * import and one spread; `operations/registry.ts` reads `easOperations` only.
 */
export const easOperations: Draft[] = [
  ...easConfigOperations,
  ...easLinkOperations,
  ...easWorkflowOperations,
  ...easUpdateOperations,
  ...easStatusOperations,
];
