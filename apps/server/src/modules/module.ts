import type { Hono } from 'hono';
import type { AppEnv, Services } from '../http.ts';

/**
 * One feature of the server (ASO, analytics, reviews, ...). A module owns its routes, services, jobs and tests in one folder,
 * `modules/<id>/`, and says how it is mounted here; `createApp` only knows the list of modules, never their insides.
 * To remove a feature, delete its folder and its line in the list; to add one, add a folder with an `index.ts` like the others.
 */
export type ServerModule<Deps> = {
  readonly id: string;
  /** Adds the module's routes (under `/api/workspaces`). `deps` are the module's seams from `AppDeps`; tests fake them. */
  mount(app: Hono<AppEnv>, services: Services, deps: Deps | undefined): void;
};
