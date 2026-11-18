import { type Action, can, roles } from '@mrm/core';
import { Hono } from 'hono';
import type { Context, Next } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Services, parseBody } from '../http.ts';
import { memberRole } from '../services/accounts.ts';
import { changeMemberRole, listMembers, removeMember } from '../services/members.ts';

const roleBody = z.object({ role: z.enum(roles) });

const param = (c: Context<AppEnv>, name: string) => c.req.param(name) ?? '';

/** Member list and member changes, mounted under /api/workspaces next to the other routes. */
export function memberRoutes(services: Services) {
  const { db, now } = services;
  const app = new Hono<AppEnv>();

  // Not a member and no such workspace look the same (404). A member without the right gets 403.
  const needs = (action: Action | 'member') => async (c: Context<AppEnv>, next: Next) => {
    const role = await memberRole(db, param(c, 'workspaceId'), c.get('user').id);
    if (!role) return c.json({ error: 'not_found' }, 404);
    if (action !== 'member' && !can(role, action)) return c.json({ error: 'forbidden' }, 403);
    c.set('role', role);
    return next();
  };

  const refuse = (c: Context<AppEnv>, reason: 'not_found' | 'forbidden' | 'last_owner') => {
    if (reason === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (reason === 'last_owner') {
      return c.json(
        {
          error: 'last_owner',
          message: 'A workspace needs at least one owner. Make someone else an owner first.',
        },
        409,
      );
    }
    return c.json({ error: 'forbidden' }, 403);
  };

  app.get('/:workspaceId/members', needs('members.read'), async (c) =>
    c.json({ members: await listMembers(db, param(c, 'workspaceId')) }),
  );

  app.patch('/:workspaceId/members/:userId', needs('members.manage'), async (c) => {
    const body = await parseBody(c, roleBody);
    if (!body.ok) return body.response;
    const done = await changeMemberRole(
      db,
      { workspaceId: param(c, 'workspaceId'), userId: param(c, 'userId'), role: body.data.role },
      { id: c.get('user').id, role: c.get('role') },
      now(),
    );
    return done.ok ? c.body(null, 204) : refuse(c, done.reason);
  });

  // Any member may call this on themselves (leave); removing others needs members.manage.
  app.delete('/:workspaceId/members/:userId', needs('member'), async (c) => {
    const done = await removeMember(
      db,
      { workspaceId: param(c, 'workspaceId'), userId: param(c, 'userId') },
      { id: c.get('user').id, role: c.get('role') },
      now(),
    );
    return done.ok ? c.body(null, 204) : refuse(c, done.reason);
  });

  return app;
}
