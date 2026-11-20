import type { Hono } from 'hono';
import type { AppEnv, Services } from '../http.ts';
import type { TestLimiter } from '../services/credential-tests.ts';
import type { TranslationContext } from '../services/translation.ts';

/**
 * One feature of the server (ASO, analytics, reviews, ...). A module owns its routes, services, jobs and tests in one folder,
 * `modules/<id>/`, and says how it is mounted here; `createApp` only knows the list of modules, never their insides.
 * To remove a feature, delete its folder and its line in the list; to add one, add a folder with an `index.ts` like the others.
 */
/** What `createApp` builds once and several modules use. */
export type ModuleShared = {
  /** The translation provider's seams (tests replace the network), also used by the reviews and the settings. */
  translation: Pick<TranslationContext, 'allowPrivateUrls' | 'fetch' | 'resolve' | 'exchange' | 'timeoutMs'>;
  /** The per workspace budget of the app sync routes, the default budget of the reviews. */
  appSyncLimiter: TestLimiter;
  /** The budget of translating stored reviews (`deps.translation.limiter`), when a test sets one. */
  translationLimiter: TestLimiter | undefined;
};

export type ServerModule<Deps> = {
  readonly id: string;
  /** Adds the module's routes (under `/api/workspaces`). `deps` are the module's seams from `AppDeps`; tests fake them. */
  mount(app: Hono<AppEnv>, services: Services, deps: Deps | undefined, shared: ModuleShared): void;
};
