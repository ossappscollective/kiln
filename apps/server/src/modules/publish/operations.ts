import { pendingOperations } from './pending-operations.ts';
import { rolloutOperations } from './rollout-operations.ts';
import { stagedChangesOperations } from './staged-operations.ts';
import { submitOperations } from './submit-operations.ts';
import { storeVersionOperations } from './version-operations.ts';

/** Every operation of the publish module, in the order the OpenAPI document lists them. */
export const publishOperations = [
  ...stagedChangesOperations,
  ...submitOperations,
  ...rolloutOperations,
  ...pendingOperations,
  ...storeVersionOperations,
];
