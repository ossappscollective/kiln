/**
 * Why Google Play refused a write of a draft, a submit or a release, in the few words a person can act on. Pure: it reads Google's own
 * error body (`error.message`, `error.errors[].reason`, `error.status`) and names a CAUSE when the wording is one of the known ones.
 *
 * The wording of Google's messages is documented only in part (the Play Developer API reference lists reasons, not sentences), so each
 * pattern below is matched against the text AND the reason, loosely, and a body that matches nothing keeps Google's own sentence: the
 * person always sees what Google said (`googleFacts`), the cause only adds what to do about it. Never a token: callers redact.
 */

export type PlayCause =
  | 'draftApp'
  | 'versionCodeUsed'
  | 'versionCodeLow'
  | 'notesTooLong'
  | 'listingIncomplete'
  | 'editConflict'
  | 'releasePermission'
  | 'sendForReview';

export type PlayCauseMatch = {
  cause: PlayCause;
  /** The error code of the web catalogue (`errors:store.google.<cause>`). */
  code: string;
  /** English sentence (the web shows its own translation of `code`). */
  message: string;
  params?: Record<string, string | number>;
};

export type GoogleFacts = {
  status: number;
  /** Google's `error.message`, whitespace collapsed. */
  message: string;
  /** `error.errors[].reason` and `error.details[].reason`, comma separated. */
  reasons: string;
  /** Google's `error.status` (`PERMISSION_DENIED`, `INVALID_ARGUMENT`, `FAILED_PRECONDITION`, ...), or ''. */
  googleStatus: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** What Google said, as short facts. Safe on any JSON (a reply that is not Google's error body gives empty strings). */
export function googleFacts(reply: { status: number; json?: unknown }): GoogleFacts {
  const error = isObject(reply.json) && isObject(reply.json.error) ? reply.json.error : {};
  const reasons: string[] = [];
  for (const list of [error.errors, error.details])
    if (Array.isArray(list))
      for (const entry of list) if (isObject(entry) && str(entry.reason) !== '') reasons.push(str(entry.reason));
  return {
    status: reply.status,
    message: str(error.message).replace(/\s+/g, ' ').trim(),
    reasons: reasons.join(','),
    googleStatus: str(error.status),
  };
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 3)}...` : text);

/** The part after "because", the reason Google gives for a refusal to send for review. */
const becauseOf = (message: string): string => {
  const at = message.search(/\bbecause\b/i);
  return at < 0 ? '' : cut(message.slice(at + 7).trim(), 200);
};

/**
 * The known cause of a refusal, or null. `status` 5xx and 401, 404 and 429 are never a cause here (they have their own handling).
 * Order matters: the most specific wording first.
 */
export function playCauseOf(facts: GoogleFacts): PlayCauseMatch | null {
  const { status, message, reasons } = facts;
  if (status < 400 || status === 401 || status === 404 || status === 429 || status >= 500) return null;
  const text = `${message} ${reasons}`;

  if (/only releases with status draft may be created on draft app|draft app/i.test(message)) {
    return {
      cause: 'draftApp',
      code: 'store.google.draftApp',
      message:
        'Google Play treats this app as a draft app (it has never been published), so only a release with the status "draft" can be created through the API. Complete the first release in Play Console (App content, store listing, a first release), or make the release a draft.',
    };
  }
  if (
    /version ?code.*(already (been )?(used|exists?)|is in use|has been used)|(already (been )?used).*version ?code|VersionConflict/i.test(
      text,
    )
  ) {
    const code = /version ?code\s*(\d+)/i.exec(message)?.[1];
    return {
      cause: 'versionCodeUsed',
      code: 'store.google.versionCodeUsed',
      message:
        'Google Play already has a build with this version code. A version code can be used once for an app, even by a build that was never released. Build again with a higher version code.',
      ...(code ? { params: { versionCode: code } } : {}),
    };
  }
  if (
    /version ?code.*(lower|less than|too low|must be greater|must be higher|older)|(downgrade|apkNoUpgradePath)/i.test(
      text,
    )
  ) {
    const code = /version ?code\s*(\d+)/i.exec(message)?.[1];
    return {
      cause: 'versionCodeLow',
      code: 'store.google.versionCodeLow',
      message:
        'The version code is lower than one Google Play already has for this app, so the build would be a downgrade. Build again with a higher version code than the highest one in Play Console.',
      ...(code ? { params: { versionCode: code } } : {}),
    };
  }
  if (
    /(release notes?|releaseNotes|what'?s new|whatsNew).*(too long|more than|exceed|maximum|max\b|characters?|length|limit)|(too long|exceed|limit).*(release notes?|releaseNotes|what'?s new)/i.test(
      text,
    )
  ) {
    const language = /\b(?:language|locale)\s*[:=]?\s*"?([a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?)"?/i.exec(
      message,
    )?.[1];
    return {
      cause: 'notesTooLong',
      code: 'store.google.notesTooLong',
      message:
        'A release note is longer than Google Play allows (500 characters per language). Shorten the notes of the language Google names, then push again.',
      ...(language ? { params: { language } } : {}),
    };
  }
  if (/\b(cannot|can'?t|could not|unable to)\b.*\b(send|submit|sent)\b.*\breview\b/i.test(message)) {
    const because = becauseOf(message);
    return {
      cause: 'sendForReview',
      code: 'store.google.sendForReview',
      message:
        'Google Play would not send the changes for review. Open Publishing overview in Play Console: it lists what is missing or what blocks the review.',
      ...(because ? { params: { reason: because } } : {}),
    };
  }
  if (
    /(feature graphic|screenshots?|hi-?res(olution)? icon|high-?res(olution)? icon|short description|full description|app icon|privacy policy|content rating|data safety|target audience|app category|contact (details|email))/i.test(
      message,
    ) &&
    /(required|must|missing|need|provide|incomplete|not (yet )?(been )?(set|filled|complete))/i.test(message)
  ) {
    const item =
      /(feature graphic|screenshots?|hi-?res(?:olution)? icon|high-?res(?:olution)? icon|short description|full description|app icon|privacy policy|content rating|data safety|target audience|app category|contact (?:details|email))/i.exec(
        message,
      )?.[1] ?? '';
    return {
      cause: 'listingIncomplete',
      code: 'store.google.listingIncomplete',
      message:
        'Google Play says the store listing or the app content is not complete. Fill in what Google names (graphics, descriptions, content rating, data safety) in Play Console, then push again.',
      ...(item ? { params: { item: item.toLowerCase() } } : {}),
    };
  }
  if (
    /editAlreadyCommitted|editNotFound|editExpired|concurrentEdit|edit.*(already (been )?committed|expired|no longer (valid|available)|conflict)|another edit|concurrent/i.test(
      text,
    )
  ) {
    return {
      cause: 'editConflict',
      code: 'store.google.editConflict',
      message:
        'Google Play says the edit conflicts with another change (a Play Console session or another tool changed this app at the same moment). Nothing was kept. Close other Play Console edits of this app, wait a minute and try again.',
    };
  }
  if (
    status === 403 &&
    /(permission|not authori[sz]ed|forbidden|not allowed|PERMISSION_DENIED)/i.test(`${text} ${facts.googleStatus}`) &&
    /(release|production|track|publish|manage|rollout)/i.test(message)
  ) {
    return {
      cause: 'releasePermission',
      code: 'store.google.releasePermission',
      message:
        'The service account is not allowed to release this app. In Play Console, Users and permissions, give it the permission to release to production (and the permission to manage testing track releases), then try again.',
    };
  }
  return null;
}
