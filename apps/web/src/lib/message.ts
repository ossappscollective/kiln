import type { Params } from './i18n/core.ts';
import { t } from './i18n/t.ts';

/**
 * A message that is kept (in `$state`, in a result object) until it is drawn, so it is written in the language that is
 * active when it is drawn, not the one that was active when it was made (docs/i18n.md, rule 9). Either a catalog key with
 * parameters (the parameters are a function, so a translated word inside them is translated at draw time too), or text
 * that is data and shown as it is (a message from the server). Build it with `msg(k('ns:key'))`, draw it with `msgText`.
 */
export type Msg =
  | { key: string; params?: () => Params }
  | { text: string }
  | { build: () => string };

export const msg = (key: string, params?: () => Params): Msg =>
  params ? { key, params } : { key };

/** Text that is shown as it is. */
export const rawMsg = (text: string): Msg => ({ text });

/** A message that is put together when it is drawn (the parts are whole sentences, each written then). */
export const builtMsg = (build: () => string): Msg => ({ build });

/** The message in the active language. Call it in a template or `$derived`, so it follows a language change. */
export const msgText = (message: Msg | null | undefined): string =>
  !message
    ? ''
    : 'key' in message
      ? t(message.key, message.params?.())
      : 'build' in message
        ? message.build()
        : message.text;
