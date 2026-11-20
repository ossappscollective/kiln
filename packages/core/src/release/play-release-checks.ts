/**
 * Local checks of a Google Play release that needs no store call (docs/adr/0025-play-release-checks.md): what can be said about a
 * proposed release from what this app already knows (the codes, the notes, the share the person set, the languages that have a
 * listing, what the target track holds). They are shown beside "Check with Google Play" and never replace it.
 *
 * Pure. ES2017 only: the web app imports this file.
 *
 * VERIFIED (Play Console help, answer 9859348, read 2026-11-20): "You can enter release notes using up to 500 Unicode characters
 * per language"; "Errors block publishing, while warnings don't"; the release name "is used only in Play Console". Google gives no
 * limit for the release name here (the 50 of release-fields.ts stays UNVERIFIED). `Release.userFraction` is "0 < fraction < 1 ...
 * can only be set when status is inProgress or halted" (developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks).
 * UNVERIFIED: whether Play refuses a version code that is lower than the one a track holds (it is only a warning here).
 */

/** The most characters of release notes per language (VERIFIED, see above). */
export const PLAY_NOTES_LIMIT = 500;

export type PlayStatus = 'draft' | 'inProgress' | 'completed';

export type PlayProposal = {
  track: string;
  releaseName: string;
  versionCodes: readonly string[];
  notes: readonly { locale: string; text: string }[];
  /** The share of users the person set, as a fraction (0.1 = 10%), or null when none was set. */
  userFraction: number | null;
};

export type PlayCheckContext = {
  /** The languages that have a store listing (a language without release notes is easy to miss). */
  listingLocales: readonly string[];
  /** The releases the target track holds now (draft, rolling out, completed), as read from the store. */
  trackReleases: readonly {
    name?: string | null;
    status: string;
    versionCodes: readonly string[];
  }[];
};

export type PlayLocalCheck = {
  code: string;
  /** `problem`: Google Play would not take it as it is. `warning`: it can go on, read it. `note`: explains. */
  severity: 'problem' | 'warning' | 'note';
  message: string;
  /** A language, for a check about one language's notes. */
  item?: string;
};

/** The state the release would be in: no share is a draft, 100% is `completed`, anything between is a rollout. */
export function playStatusOf(userFraction: number | null): PlayStatus {
  if (userFraction === null) return 'draft';
  return userFraction >= 1 ? 'completed' : 'inProgress';
}

const percent = (fraction: number): string => `${Math.round(fraction * 10000) / 100}%`;

/** What the state means, in plain words (a draft is not live; a rollout is; 100% is "completed"). */
export function playStateText(
  status: PlayStatus,
  userFraction: number | null,
  track: string,
): string {
  if (status === 'draft')
    return `As a draft the release is saved in the ${track} track and goes to nobody. It starts only when you release it with a share of users.`;
  if (status === 'completed')
    return `Released to everybody: 100% of the users of the ${track} track. Google Play calls this a completed release, and it has no share.`;
  return `Rolling out to ${percent(userFraction ?? 0)} of the users of the ${track} track. You can raise the share, halt it or complete it later.`;
}

const codeNumber = (code: string): number =>
  /^[0-9]{1,10}$/.test(code) ? Number(code) : Number.NaN;

const LIVE = ['completed', 'inProgress', 'halted'];

/** The checks, problems first. Nothing here asks a store. */
export function checkPlayProposal(
  proposal: PlayProposal,
  context: PlayCheckContext,
): PlayLocalCheck[] {
  const out: PlayLocalCheck[] = [];
  const add = (check: PlayLocalCheck) => {
    out.push(check);
  };
  const track = proposal.track.trim();
  if (track === '')
    add({ code: 'track_missing', severity: 'problem', message: 'Name the track to release in.' });

  // Version codes
  if (proposal.versionCodes.length === 0) {
    add({
      code: 'codes_missing',
      severity: 'problem',
      message: 'Choose at least one version code for the release.',
    });
  } else {
    const held: string[] = [];
    let highest = 0;
    for (const release of context.trackReleases) {
      if (LIVE.indexOf(release.status) === -1) continue;
      for (const code of release.versionCodes) {
        held.push(code);
        const n = codeNumber(code);
        if (n > highest) highest = n;
      }
    }
    const already = proposal.versionCodes.filter((c) => held.indexOf(c) !== -1);
    if (already.length > 0) {
      add({
        code: 'code_already_live',
        severity: 'problem',
        message: `Version code ${already.join(', ')} is already in a release of ${track} that is live or rolling out. Choose a code that is not released there yet.`,
      });
    }
    const lower = proposal.versionCodes.filter((c) => {
      const n = codeNumber(c);
      return held.indexOf(c) === -1 && n <= highest && n > 0;
    });
    if (lower.length > 0) {
      add({
        code: 'code_not_newer',
        severity: 'warning',
        message: `Version code ${lower.join(', ')} is lower than ${highest}, which ${track} already holds. People who have ${highest} are not offered a lower code, so they will not get this release.`,
      });
    }
    if (proposal.versionCodes.some((c) => Number.isNaN(codeNumber(c)))) {
      add({
        code: 'code_invalid',
        severity: 'problem',
        message: 'A version code is a whole number.',
      });
    }
  }

  // The share
  const fraction = proposal.userFraction;
  if (fraction !== null) {
    if (!(fraction > 0 && fraction <= 1)) {
      add({
        code: 'fraction_out_of_range',
        severity: 'problem',
        message:
          'The share of users must be more than 0% and at most 100%. Google Play keeps a share only between 0 and 1, and 100% is a completed release.',
      });
    } else if (fraction === 1) {
      add({
        code: 'full_rollout',
        severity: 'note',
        message:
          '100% is sent to Google Play as a completed release with no share: everybody gets it at once.',
      });
    }
  }

  // The release name
  if (proposal.releaseName.trim() === '') {
    add({
      code: 'name_empty',
      severity: 'warning',
      message:
        'The release name is empty. It is only shown in Play Console, but a name (for example the version) makes the release easy to find.',
    });
  }

  // The release notes
  const written = proposal.notes.filter((n) => n.text.trim() !== '');
  for (const note of written) {
    const length = Array.from(note.text.trim()).length;
    if (length > PLAY_NOTES_LIMIT) {
      add({
        code: 'notes_over_limit',
        severity: 'problem',
        item: note.locale,
        message: `The release notes for ${note.locale} have ${length} characters. Google Play allows at most ${PLAY_NOTES_LIMIT} per language.`,
      });
    }
  }
  const have: string[] = written.map((n) => n.locale.replace(/_/g, '-').toLowerCase());
  if (written.length === 0) {
    add({
      code: 'notes_none',
      severity: 'warning',
      message: 'The release has no release notes. Players see an empty "What is new".',
    });
  } else {
    for (const locale of context.listingLocales) {
      if (have.indexOf(locale.replace(/_/g, '-').toLowerCase()) === -1) {
        add({
          code: 'notes_missing',
          severity: 'warning',
          item: locale,
          message: `There are no release notes for ${locale}, a language that has a listing.`,
        });
      }
    }
  }

  const rank = { problem: 0, warning: 1, note: 2 } as const;
  return out
    .map((check, i) => ({ check, i }))
    .sort((a, b) => rank[a.check.severity] - rank[b.check.severity] || a.i - b.i)
    .map((x) => x.check);
}
