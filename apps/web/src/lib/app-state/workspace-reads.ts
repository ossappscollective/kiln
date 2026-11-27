import type { Api } from '../api.ts';

/**
 * The reads of the workspace's shared facts that a screen needs outside the model's own stores: the app list, one app, the sync activity
 * and the plans of an app. A component never calls `api.apps` / `api.app` / `api.syncActivity` / `api.appPlans` itself (component guard
 * R1): it asks here. One reader per fact means a burst of screens that open together (the shell, a page, a dialog) share ONE request
 * instead of each fetching and each seeing a different moment; the answer has the shape of the endpoint, so a screen keeps its own
 * loading and error handling.
 */
const running = new Map<string, Promise<unknown>>();

function shared<T>(key: string, read: () => Promise<T>): Promise<T> {
  const existing = running.get(key);
  if (existing) return existing as Promise<T>;
  const request = read().finally(() => {
    if (running.get(key) === request) running.delete(key);
  });
  running.set(key, request);
  return request;
}

/** The apps of the workspace. */
export const readApps = (api: Api, workspaceId: string) =>
  shared(`apps:${workspaceId}`, () => api.apps(workspaceId));

/** One app with its members. */
export const readApp = (api: Api, workspaceId: string, appId: string) =>
  shared(`app:${workspaceId}:${appId}`, () => api.app(workspaceId, appId));

/** The feeds being read from the stores right now, and how many store jobs wait. */
export const readSyncActivity = (api: Api, workspaceId: string) =>
  shared(`sync-activity:${workspaceId}`, () => api.syncActivity(workspaceId));

/** The plans of one app. */
export const readAppPlans = (api: Api, workspaceId: string, appId: string) =>
  shared(`plans:${workspaceId}:${appId}`, () => api.appPlans(workspaceId, appId));
