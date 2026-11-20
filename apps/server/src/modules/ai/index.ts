import { aiLimits } from '@mrm/core';
import type { ServerModule } from '../module.ts';
import { createTestLimiter, type TestLimiter } from '../../services/credential-tests.ts';
import type { AiContext } from './ai-config.ts';
import { createConcurrencyGate } from './ai-usage.ts';
import { releaseNotesTranslateRoutes } from './notes-translate-routes.ts';
import { aiRoutes } from './routes.ts';
import type { AiServices } from './service.ts';

/**
 * AI provider settings (docs/api/ai.md). `enabled` is MRM_AI_ENABLED (default false: no provider is ever contacted),
 * `allowPrivateUrls` is MRM_AI_ALLOW_PRIVATE_URLS. `fetch` replaces the network for Anthropic and OpenAI, `resolve` and
 * `exchange` for an OpenAI compatible server, `clientFactory` hands in a whole client (tests use a fake). `limiter` is the
 * per workspace budget of runs a minute.
 */
export type AiSettings = {
  enabled?: boolean;
  allowPrivateUrls?: boolean;
  fetch?: typeof fetch;
  resolve?: AiContext['resolve'];
  exchange?: AiContext['exchange'];
  timeoutMs?: number;
  clientFactory?: AiContext['clientFactory'];
  limiter?: TestLimiter;
};

/** What the module needs from the app: its own settings and what it borrows from the ASO and reviews modules. */
export type AiDeps = {
  settings?: AiSettings | undefined;
  /** Requests of "translate the release notes" per workspace per minute (default 10). */
  notesLimiter?: TestLimiter | undefined;
  /** The ASO limits the keyword tasks respect. */
  asoLimits: AiServices['asoLimits'];
  /** Whether a reply may be drafted at the store, and the connector that does it (accepting a reply proposal). */
  reply: {
    enabled: boolean;
    connectorFactory: AiServices['reply']['replyConnectorFactory'];
  };
};

/**
 * AI assistance: suggestions for keywords, listing text and review replies, and translating the release notes. OFF unless
 * MRM_AI_ENABLED and the workspace turns it on. It only PROPOSES: accepting calls the keyword, staged text and reply draft
 * services; nothing here can push, submit, publish, release or send. Mount it after the modules it hands proposals to.
 */
export const aiModule: ServerModule<AiDeps> = {
  id: 'ai',
  mount(app, services, deps, shared) {
    if (!deps) throw new Error('The AI module needs the ASO limits and the reply connector.');
    const { db, masterKey, now } = services;
    const ai = deps.settings;
    const aiContext = {
      db,
      masterKey,
      now,
      enabled: ai?.enabled ?? false,
      ...(ai?.allowPrivateUrls ? { allowPrivateUrls: true } : {}),
      ...(ai?.fetch ? { fetch: ai.fetch } : {}),
      ...(ai?.resolve ? { resolve: ai.resolve } : {}),
      ...(ai?.exchange ? { exchange: ai.exchange } : {}),
      ...(ai?.timeoutMs !== undefined ? { timeoutMs: ai.timeoutMs } : {}),
      ...(ai?.clientFactory ? { clientFactory: ai.clientFactory } : {}),
    };
    const gate = createConcurrencyGate(aiLimits.maxConcurrentPerWorkspace);
    app.route(
      '/api/workspaces',
      aiRoutes({
        ...aiContext,
        asoLimits: deps.asoLimits,
        assets: { repo: shared.repo },
        reply: {
          db,
          masterKey,
          now,
          replyEnabled: deps.reply.enabled,
          replyConnectorFactory: deps.reply.connectorFactory,
        },
        gate,
        limiter: ai?.limiter ?? createTestLimiter({ now, limit: aiLimits.runsPerMinute }),
      }),
    );
    // The AI engine of the notes translation shares the concurrency gate, the usage rows, the budget and the cost cap.
    app.route(
      '/api/workspaces',
      releaseNotesTranslateRoutes({
        db,
        now,
        translation: { db, masterKey, now, ...shared.translation },
        ai: aiContext,
        gate,
        limiter: deps.notesLimiter ?? createTestLimiter({ now, limit: 10 }),
      }),
    );
  },
};
