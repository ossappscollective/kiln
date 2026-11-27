import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * No screen decides the state of the app by itself (docs/state-model.md, "Enforcement").
 *
 * The state of an app (what is pending, what publishes, what failed, which button may be pressed and why not) is derived in ONE place:
 * lib/app-state/ (the pure model `deriveAppState`, and the store `appStateStore` that reads the facts once). These tests read the SOURCE
 * of every component and module (no DOM runs here) and fail when one outside that place reads the low-level sources that facts come from
 * or computes a state-dependent `disabled` of its own. That is how the top bar said "Pending 29" while the card said "Nothing is waiting":
 * two screens each decided for themselves.
 *
 * When this fails for your file: do not add it to an allowlist. Use the app-state store:
 *
 *     import { appStateStore } from '<lib>/app-state/app-state-store.svelte.ts';
 *     const appState = $derived(appStateStore.of({ workspaceId, role, records: members, scope }));  // the whole state of the app
 *     const verdict = $derived(appStateStore.verdict(workspaceId, role, app, 'submit'));            // one button: { enabled, reason }
 *     const line = appStateStore.lineOf(workspaceId, appIds);                                       // a count for a chip
 *
 * and draw `appState.headline`, `appState.primaryAction`, `verdict.enabled` / `verdict.reason`. A new rule goes into lib/app-state/derive.ts.
 */
const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourcesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(SRC, dir))) {
    const path = join(dir, name);
    if (statSync(join(SRC, path)).isDirectory()) out.push(...sourcesUnder(path));
    else if (/\.(svelte|ts)$/.test(name) && !/\.test\.ts$/.test(name))
      out.push(path.split(sep).join('/'));
  }
  return out;
}

/** The code of a file: its comments do not count (a comment may name what it replaced). */
function codeOf(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const COMPONENTS = [...sourcesUnder('components'), 'App.svelte'];
const LIB = sourcesUnder('lib');

type Rule = {
  /** What it forbids, in the words of the failure. */
  what: string;
  /** What to use instead. */
  instead: string;
  pattern: RegExp;
  files: readonly string[];
  /** Files that may still match, each with the reason. A stale entry (the file no longer matches) fails too. */
  allow: Readonly<Record<string, string>>;
};

const MODEL = 'lib/app-state/';

const RULES: Rule[] = [
  {
    what: 'import the publishing claims store or the cart summary store',
    instead:
      'read the app-state store: `appStateStore.of(...)` for the state, `.verdict(...)` for a button, `.lineOf(...)` for a count',
    pattern: /\bfrom\s+'[^']*(?:publishing-store|cart-summary)\.svelte(?:\.ts)?'/,
    files: [...COMPONENTS, ...LIB],
    allow: {
      'lib/publishing-store.svelte.ts':
        'it IS the claims store the app-state store reads (it reads the cart summary to know what a publish emptied)',
    },
  },
  {
    what: 'read the pending count, what publishes or what failed from a low-level store',
    instead:
      'read the app-state store (one count, one place): `appStateStore.of(...).pendingCount`, `.publishing`, `.failures`',
    pattern:
      /\b(?:publishingStore|cartSummaryStore)\b|\bpendingStore\.(?:summary|loadSummary|viewsOf)\b|\bpipelineStore\.(?:summary|app|loadSummary)\b/,
    files: [...COMPONENTS, ...LIB],
    allow: {
      'lib/publishing-store.svelte.ts': 'it IS the claims store the app-state store reads',
      'lib/cart-summary.svelte.ts': 'it IS the cart summary store the app-state store reads',
      'lib/pending-store.svelte.ts':
        'it IS the pending content store (views, summary) the app-state store reads',
      'components/publish/PublishDialog.svelte':
        'it reports its own publish to the claims store; it reads nothing back to decide with',
    },
  },
  {
    what: 'compute the next step, the promote offer, the release candidate or the pending line with the low-level helpers',
    instead:
      'read `appStateStore.of(...)` (`primaryAction`, `secondaryActions`, `promotion`, `candidates`, `obsolete`, `notices`, `flow`) or `appStateStore.lineOf(...)`',
    pattern:
      /\b(?:lineFor|chooseNextStep|nextStepTrains|orderTrains|releaseTrains|releaseTrainsByPlatform|trainInputOf|promoteOptions?|promoteHref|analyzeCandidates|candidateTrain|compareVersionStrings|obsoleteVersions|pipelineIsObsolete)\b/,
    files: [...COMPONENTS, ...LIB],
    allow: {
      'lib/play-promote.ts': 'it DEFINES the promote option the model offers',
      'lib/pending.ts':
        'it DEFINES lineFor (the pending line from the summary) that the model builds its count facts with',
      'lib/next-step.ts':
        'it DEFINES the next-step choice that the model derives its release flow from',
      'lib/release-trains.ts':
        'it DEFINES the release trains (a version on its way, one strip, one button) that the model derives its release flow from',
    },
  },
  {
    what: 'import the release trains, the next-step choice or the promote option outside the model',
    instead:
      'the release flow is decided in lib/app-state/ only: read `appStateStore.of(...).flow`, `.candidates` and `.promotion`. (`STEP_HELP` of the strip is words, not a decision: the strip component may read it)',
    pattern:
      /\bfrom\s+'[^']*\/(?:next-step|release-trains|play-promote)(?:\.ts)?'/,
    files: [...COMPONENTS, ...LIB],
    allow: {
      'components/release/TrainSteps.svelte': 'it draws the five steps of a train and only reads their help texts (STEP_HELP)',
      'components/release/stepper/ReleaseStepper.svelte':
        'it only parses and carries the `Promote` address (source track and codes) of an offer the model made',
      'components/release/stepper/StepNotes.svelte': 'it only reads the `Promote` address the stepper carries',
      'components/release/stepper/StepBuild.svelte': 'it only reads the `Promote` address the stepper carries',
      'components/app/AppReleases.svelte':
        'it only parses the `Promote` address (`promoteFromHash`) to open the stepper on it',
      'lib/next-step.ts': 'it builds the next-step card from the trains: both are internal to the model',
    },
  },
  {
    what: 'read the pending count or the visibility of the top bar button from the button plumbing',
    instead: 'the top bar says what the model says: `appStateStore.topBar(workspaceId)`',
    pattern: /\bcartButton\.(?:count|visible)\b/,
    files: [...COMPONENTS, ...LIB],
    allow: {},
  },
  {
    what: 'compute a state-dependent `disabled` of its own (a running publish, a failed publish, the pending count)',
    instead:
      "take `disabled` from the model: `!verdict.enabled` (with `verdict.reason` as the title) or an offer's `enabled` / `disabledReason`",
    pattern:
      /\bdisabled\b[^\n]*\b(?:publishingNow|isPublishing|publishing\.length|publishingStore|\.pendingCount|lastPublish|failedIds)\b/,
    files: COMPONENTS,
    allow: {},
  },
];

for (const rule of RULES) {
  test(`no screen may ${rule.what}`, () => {
    const hits: string[] = [];
    const allowed = new Set(Object.keys(rule.allow));
    const matching = new Set<string>();
    for (const file of rule.files) {
      if (file.startsWith(MODEL)) continue; // the model and the store ARE the one place
      if (!rule.pattern.test(codeOf(file))) continue;
      matching.add(file);
      if (!allowed.has(file)) hits.push(file);
    }
    assert.deepEqual(
      hits,
      [],
      `${hits.join(', ')} must not ${rule.what}. Two screens deciding for themselves is how the top bar says "Pending 29" while the card says "Nothing is waiting". ` +
        `Use the app-state store (apps/web/src/lib/app-state/app-state-store.svelte.ts): ${rule.instead}. Do not add the file to the allowlist of this test.`,
    );
    const stale = [...allowed].filter((file) => !matching.has(file));
    assert.deepEqual(
      stale,
      [],
      `${stale.join(', ')} no longer match "${rule.what}": remove them from the allowlist (it lists exactly what is still allowed, with a reason)`,
    );
  });
}

/** The screens that were moved onto the model: each must still read it (a revert to its own computation would not fail the rules above). */
const ON_THE_MODEL = [
  'components/Shell.svelte',
  'components/app/AppShell.svelte',
  'components/app/AppReleases.svelte',
  'components/app/AppDashboard.svelte',
  'components/app/NextStep.svelte',
  'components/app/PendingCart.svelte',
  'components/app/PendingCartButton.svelte',
  'components/app/PendingCartDrawer.svelte',
  'components/dashboard/Board.svelte',
  'components/listing/StagedTrayApp.svelte',
  'components/listing/SubmitReady.svelte',
  'components/publish/ReviewInfoCopy.svelte',
  'components/pending/WorkspacePending.svelte',
  'components/Portfolio.svelte',
  'components/publish/PendingChanges.svelte',
  'components/release/ReleaseRowDetail.svelte',
  'components/release/ReleaseTable.svelte',
  'components/release/RolloutAppControl.svelte',
  'components/release/stepper/CreateVersion.svelte',
  'components/release/stepper/StoreRelease.svelte',
];

test('the screens that were moved onto the state model still read it', () => {
  for (const file of ON_THE_MODEL)
    assert.match(
      codeOf(file),
      /\bappStateStore\b/,
      `${file} no longer reads the app-state store (apps/web/src/lib/app-state/app-state-store.svelte.ts): it must not decide the state by itself`,
    );
});

test('the small components that show a verdict or a line are given it, they do not look it up', () => {
  const note = codeOf('components/publish/PublishingNote.svelte');
  assert.match(note, /verdict/);
  assert.doesNotMatch(
    note,
    /Store\b/,
    'PublishingNote draws the verdict it is given; it reads no store',
  );
  const chip = codeOf('components/publish/PendingChip.svelte');
  assert.doesNotMatch(chip, /Store\b/, 'PendingChip draws the line it is given; it reads no store');
});

test('the allowlists list files that exist', () => {
  for (const rule of RULES)
    for (const file of Object.keys(rule.allow))
      assert.ok(
        readFileSync(join(SRC, file), 'utf8').length > 0,
        `${file} is in an allowlist but is missing`,
      );
});
