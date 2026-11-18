import { type Action, can } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { streamSSE } from 'hono/streaming';
import { type AppEnv, type Services, queryInt } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { eventReadAction, eventTypes } from '../services/event-types.ts';
import {
  DEFAULT_EVENTS_LIMIT,
  MAX_EVENTS_LIMIT,
  latestEventId,
  listEvents,
  subscribeToEvents,
} from '../services/events.ts';
import { tokenStillValid } from '../services/tokens.ts';

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';
const ws = (c: Context<AppEnv>) => param(c, 'workspaceId');

export const MAX_STREAMS_PER_USER = 5;
export const HEARTBEAT_MS = 15_000;
/** The stream also reads the table this often, to find events written by another process. */
export const POLL_MS = 2_000;

export type EventStreamOptions = { maxPerUser?: number; heartbeatMs?: number; pollMs?: number };

/**
 * Tracks the open event streams: how many each person has (a cap), and a way to end them all at
 * shutdown, which would otherwise wait for them forever.
 */
export function createEventStreamHub(options: EventStreamOptions = {}) {
  const maxPerUser = options.maxPerUser ?? MAX_STREAMS_PER_USER;
  const perUser = new Map<string, number>();
  const closers = new Set<() => void>();
  let closed = false;
  return {
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
    pollMs: options.pollMs ?? POLL_MS,
    /** Reserves a stream for the person. Returns how to give it back, or undefined when they have too many (or the server is stopping). */
    open(userId: string, close: () => void): (() => void) | undefined {
      const count = perUser.get(userId) ?? 0;
      if (closed || count >= maxPerUser) return undefined;
      perUser.set(userId, count + 1);
      closers.add(close);
      return () => {
        closers.delete(close);
        const left = (perUser.get(userId) ?? 1) - 1;
        if (left <= 0) perUser.delete(userId);
        else perUser.set(userId, left);
      };
    },
    /** Ends every open stream and refuses new ones. */
    closeAll() {
      closed = true;
      for (const close of [...closers]) close();
    },
    get size() {
      return closers.size;
    },
  };
}
export type EventStreamHub = ReturnType<typeof createEventStreamHub>;

const invalid = (c: Context, path: string, message: string) =>
  c.json({ error: 'invalid_request', issues: [{ path, message }] }, 400);

/** `?type=a,b` as a list of known types, or the problem. */
function parseTypes(raw: string | undefined): string[] | { error: string } {
  if (raw === undefined || raw === '') return [];
  const types = raw.split(',').map((t) => t.trim());
  const unknown = types.find((t) => !(eventTypes as readonly string[]).includes(t));
  return unknown === undefined ? types : { error: `Unknown event type "${unknown}".` };
}

/** Event feed and live stream, mounted under /api/workspaces. */
export function eventRoutes(services: Services, hub: EventStreamHub) {
  const { db, now } = services;
  const app = new Hono<AppEnv>();

  const needs = (action: Action) => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, ws(c), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (!can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  /** The types this request may see: those whose subject the role may read, and what was asked for. */
  const visibleTypes = (c: Context<AppEnv>, asked: string[]) => {
    const role = c.get('role');
    const visible = eventTypes.filter((t) => can(role, eventReadAction[t]));
    return asked.length > 0 ? visible.filter((t) => asked.includes(t)) : visible;
  };

  app.get('/:workspaceId/events', needs('events.read'), async (c) => {
    const limit = queryInt(c.req.query('limit'), { fallback: DEFAULT_EVENTS_LIMIT, max: MAX_EVENTS_LIMIT });
    if (limit === undefined) return invalid(c, 'limit', `Use a whole number from 1 to ${MAX_EVENTS_LIMIT}.`);
    const rawSince = c.req.query('since');
    if (rawSince !== undefined && !/^[0-9]{1,15}$/.test(rawSince)) return invalid(c, 'since', 'Use an event id (a whole number, 0 or more).');
    const asked = parseTypes(c.req.query('type'));
    if (!Array.isArray(asked)) return invalid(c, 'type', asked.error);
    const since = rawSince === undefined ? undefined : Number(rawSince);
    const types = visibleTypes(c, asked);
    const appIds = c.get('token')?.appIds ?? undefined;
    const page =
      types.length === 0
        ? { events: [], hasMore: false }
        : await listEvents(db, ws(c), { since, limit, types, appIds: appIds ?? undefined });
    const last = page.events[page.events.length - 1];
    return c.json({ events: page.events, hasMore: page.hasMore, nextCursor: last?.id ?? since ?? 0 });
  });

  app.get('/:workspaceId/events/stream', needs('events.read'), async (c) => {
    const workspaceId = ws(c);
    const userId = c.get('user').id;
    const tokenId = c.get('token')?.tokenId;
    const asked = parseTypes(c.req.query('type'));
    if (!Array.isArray(asked)) return invalid(c, 'type', asked.error);
    const types = visibleTypes(c, asked);
    const appIds = c.get('token')?.appIds ?? undefined;

    // Where to resume: Last-Event-ID (what a browser's EventSource sends), else ?since=, else now.
    const rawCursor = c.req.header('last-event-id') ?? c.req.query('since');
    if (rawCursor !== undefined && !/^[0-9]{1,15}$/.test(rawCursor)) return invalid(c, 'since', 'Use an event id (a whole number, 0 or more).');
    let cursor = rawCursor === undefined ? await latestEventId(db, workspaceId) : Number(rawCursor);

    let wake = () => {};
    let finished = false;
    const finish = () => {
      finished = true;
      wake();
    };
    const release = hub.open(userId, finish);
    if (!release) {
      return c.json(
        { error: 'too_many_streams', message: 'Too many event streams are open. Close one and try again.' },
        429,
        { 'Retry-After': '5' },
      );
    }
    const unsubscribe = subscribeToEvents(workspaceId, () => wake());
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      stream.onAbort(finish);
      try {
        // The browser retries after this many milliseconds if the connection drops.
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ cursor }), retry: 3000 });
        let lastBeat = Date.now();
        while (!finished) {
          // Drain what is there, in pages, before waiting.
          for (;;) {
            if (types.length === 0) break;
            const { events, hasMore } = await listEvents(db, workspaceId, { since: cursor, limit: MAX_EVENTS_LIMIT, types, appIds });
            for (const event of events) {
              if (finished) break;
              await stream.writeSSE({ id: String(event.id), event: event.type, data: JSON.stringify(event) });
              cursor = event.id;
            }
            if (!hasMore || finished) break;
          }
          if (finished) break;
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, hub.pollMs);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
            if (finished) wake();
          });
          if (finished) break;
          if (Date.now() - lastBeat >= hub.heartbeatMs) {
            lastBeat = Date.now();
            // Still allowed? A revoked token or a removed member ends the stream.
            const stillMember = await memberRole(db, workspaceId, userId);
            const stillValid = tokenId === undefined || (await tokenStillValid(db, tokenId, now()));
            if (!stillMember || !stillValid) break;
            await stream.write(': heartbeat\n\n');
          }
        }
      } finally {
        finished = true;
        unsubscribe();
        release();
      }
    });
  });

  return app;
}
