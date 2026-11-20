import type { Hono } from 'hono';
import type { AppEnv, Services } from '../../http.ts';
import type { ModuleShared } from '../module.ts';
import type { EasDeps } from './index.ts';

/** One piece of the EAS module: it mounts its routes. Each feature adds one entry to `easParts` and one array to `easOperations`. */
export type EasPart = (
  app: Hono<AppEnv>,
  services: Services,
  deps: EasDeps | undefined,
  shared: ModuleShared,
) => void;

/** The mounts of the EAS module, in order. Add yours with one import and one entry. */
export const easParts: EasPart[] = [];
