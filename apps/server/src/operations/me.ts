import { z } from 'zod';
import { SERVER_LOCALES } from '../i18n/runtime.ts';
import { updateMeBody } from '../routes/me-locale.ts';
import type { Draft } from './shared.ts';
import { userSchema } from './workspace.ts';

/** The signed-in person's own settings (docs/api/profile.md). Session cookie only: a token has no identity of its own. */
export const meOperations: Draft[] = [
  {
    id: 'updateMe',
    method: 'patch',
    path: '/api/me',
    tags: ['auth'],
    summary: 'Set the language you read',
    description: `Sets \`locale\`, the language of the emails the server sends you without a request to read it from (alerts and the alert digest). One of ${SERVER_LOCALES.map((l) => `\`${l}\``).join(', ')}; a region is accepted and dropped (\`fr-CA\` is \`fr\`); \`null\` clears the choice (English). Emails that answer a request (sign-in code, address verification, mail test) follow that request's \`Accept-Language\` instead. Session cookie only.`,
    risk: 'write',
    access: 'user',
    body: updateMeBody,
    responses: {
      '200': {
        description: 'The user, with the stored `locale`.',
        schema: z.object({ user: userSchema }),
      },
    },
  },
];
