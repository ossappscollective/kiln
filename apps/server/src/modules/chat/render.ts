import type { ChatDigest, ChatMessage, ChatProvider } from './model.ts';
import { renderSlackDigest, renderSlackMessage } from './slack.ts';
import { renderTeamsDigest, renderTeamsMessage } from './teams.ts';

/** The JSON body to POST for a provider. */
export const renderMessage = (provider: ChatProvider, m: ChatMessage): object =>
  provider === 'slack' ? renderSlackMessage(m) : renderTeamsMessage(m);

export const renderDigest = (provider: ChatProvider, d: ChatDigest): object =>
  provider === 'slack' ? renderSlackDigest(d) : renderTeamsDigest(d);
