import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { CatalogEntry } from '../alerts/alerts.ts';
import {
  type ChatDelivery,
  type ChatDestination,
  createInput,
  defaultRouteForms,
  describeOutcome,
  describeRoute,
  emptyDestinationForm,
  emptyRouteForm,
  formFromDestination,
  groupState,
  hasProblems,
  helpSteps,
  inFlight,
  outcomeKeys,
  patchFor,
  routeFormFrom,
  routeInputFrom,
  routeProblem,
  statusView,
  testResult,
  toggleGroup,
  typeGroups,
  validateDestinationForm,
} from './chat.ts';

const destination: ChatDestination = {
  id: 'd1',
  provider: 'slack',
  name: 'Releases',
  urlHint: 'abcd',
  locale: 'fr',
  enabled: true,
  allowAnyHost: false,
  digest: 'off',
  digestHour: 8,
  timezone: 'UTC',
  createdAt: 1,
  updatedAt: 1,
  routes: [],
  lastDelivery: null,
};

const entry = (id: string, group: string, groupLabel: string): CatalogEntry =>
  ({ id, group, groupLabel, label: id }) as CatalogEntry;

test('a new destination needs a name and an https address; editing may keep the saved address', () => {
  const form = emptyDestinationForm('de', 'Europe/Berlin');
  assert.equal(form.locale, 'de');
  assert.equal(form.timezone, 'Europe/Berlin');
  const empty = validateDestinationForm(form, false);
  assert.ok(empty.name && empty.url);
  assert.equal(
    hasProblems(
      validateDestinationForm({ ...form, name: 'A', url: 'http://hooks.slack.com/x' }, false),
    ),
    true,
  );
  assert.equal(
    hasProblems(
      validateDestinationForm(
        { ...form, name: 'A', url: 'https://hooks.slack.com/services/x' },
        false,
      ),
    ),
    false,
  );
  assert.equal(
    validateDestinationForm({ ...form, name: 'A' }, true).url,
    undefined,
    'editing: empty means keep',
  );
  assert.ok(validateDestinationForm({ ...form, name: 'A', url: 'nope' }, true).url);
  assert.ok(
    validateDestinationForm({ ...form, name: 'x'.repeat(81), url: 'https://a.b/c' }, false).name,
  );
  assert.ok(
    validateDestinationForm(
      { ...form, name: 'A', url: 'https://a.b/c', digest: 'daily', timezone: ' ' },
      false,
    ).timezone,
  );
});

test('what is sent: the address only when typed, and only what changed', () => {
  const form = formFromDestination(destination);
  assert.equal(form.url, '', 'the saved address is never in the form');
  assert.deepEqual(patchFor(destination, form), {});
  assert.deepEqual(
    patchFor(destination, { ...form, name: ' New ', locale: 'es', digest: 'daily' }),
    {
      name: 'New',
      locale: 'es',
      digest: 'daily',
    },
  );
  assert.deepEqual(
    patchFor(destination, { ...form, url: ' https://hooks.slack.com/services/new ' }),
    {
      url: 'https://hooks.slack.com/services/new',
    },
  );
  const created = createInput({
    ...emptyDestinationForm(),
    name: ' Room ',
    url: ' https://hooks.slack.com/services/a ',
  });
  assert.equal(created.name, 'Room');
  assert.equal(created.url, 'https://hooks.slack.com/services/a');
  assert.equal(created.provider, 'slack');
  assert.ok(!('routes' in created), 'the server gives the default rules');
});

test('routing rules: form and API shape both ways, with "all" meaning null', () => {
  const route = {
    id: 'r1',
    alertTypes: ['*'],
    minSeverity: 'critical' as const,
    appIds: null,
    platforms: null,
    enabled: true,
  };
  const form = routeFormFrom(route);
  assert.equal(form.allTypes, true);
  assert.equal(form.allApps, true);
  assert.deepEqual(routeInputFrom(form), {
    alertTypes: ['*'],
    minSeverity: 'critical',
    appIds: null,
    platforms: null,
    enabled: true,
  });
  const picked = routeFormFrom({
    ...route,
    alertTypes: ['release.live', 'release.rejected'],
    appIds: ['a1'],
    platforms: ['ios'],
    minSeverity: 'info',
  });
  assert.equal(picked.allTypes, false);
  assert.deepEqual(routeInputFrom(picked), {
    alertTypes: ['release.live', 'release.rejected'],
    minSeverity: 'info',
    appIds: ['a1'],
    platforms: ['ios'],
    enabled: true,
  });
  assert.ok(routeProblem({ ...emptyRouteForm(), allTypes: false }));
  assert.equal(routeProblem(emptyRouteForm()), undefined);
  // "Specific apps" with none ticked is "all apps", not a rule that can never match.
  assert.equal(routeInputFrom({ ...emptyRouteForm(), allApps: false, appIds: [] }).appIds, null);
});

test('groups of alert types: toggling a group and its state', () => {
  const groups = typeGroups([
    entry('release.live', 'releases', 'Releases'),
    entry('release.halted', 'releases', 'Releases'),
    entry('review.new', 'reviews', 'Reviews'),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.id, g.types.length]),
    [
      ['releases', 2],
      ['reviews', 1],
    ],
  );
  const releases = groups[0];
  assert.ok(releases);
  assert.deepEqual(toggleGroup([], releases, true), ['release.live', 'release.halted']);
  assert.deepEqual(toggleGroup(['release.live', 'review.new'], releases, false), ['review.new']);
  assert.equal(groupState(['release.live'], releases), 'some');
  assert.equal(groupState(['release.live', 'release.halted'], releases), 'all');
  assert.equal(groupState([], releases), 'none');
});

test('the cells of a rule, with app names', () => {
  const cells = describeRoute(
    {
      id: 'r',
      alertTypes: ['release.live', 'release.halted'],
      minSeverity: 'warning',
      appIds: ['a1', 'gone'],
      platforms: ['ios', 'android'],
      enabled: true,
    },
    [{ id: 'a1', name: 'Moon Diary' }],
  );
  assert.equal(cells.apps, 'Moon Diary, gone');
  assert.equal(cells.platforms, 'iOS, Android');
  assert.match(cells.types, /2/);
  const all = describeRoute(
    {
      id: 'r',
      alertTypes: ['*'],
      minSeverity: 'critical',
      appIds: null,
      platforms: null,
      enabled: true,
    },
    [],
  );
  assert.notEqual(all.types, cells.types);
  assert.ok(all.apps && all.platforms && all.severity);
});

test('every outcome code the server writes has a sentence, and no sentence is for a code it never writes', () => {
  const source = readFileSync(
    new URL('../../../../server/src/modules/chat/model.ts', import.meta.url),
    'utf8',
  );
  const block = /export const chatOutcomes = \[([^\]]*)\]/.exec(source);
  assert.ok(block);
  const codes = (block[1] ?? '')
    .split(',')
    .map((s) => s.replace(/['\s]/g, ''))
    .filter((s) => s !== '');
  assert.ok(codes.length > 10);
  assert.deepEqual(Object.keys(outcomeKeys).sort(), codes.slice().sort());
  for (const code of codes)
    assert.notEqual(describeOutcome(code), describeOutcome('something_new'), code);
  const statuses = /export const chatStatuses = \[([^\]]*)\]/.exec(source);
  for (const s of (statuses?.[1] ?? '')
    .split(',')
    .map((x) => x.replace(/['\s]/g, ''))
    .filter(Boolean))
    assert.notEqual(statusView(s).label, s, `${s} has a label`);
});

test('statuses, the test result line and the live log', () => {
  const d = (status: ChatDelivery['status'], outcome = 'ok') =>
    ({ status, outcome }) as ChatDelivery;
  assert.equal(statusView('sent').tone, 'ok');
  assert.equal(statusView('failed').tone, 'bad');
  assert.equal(statusView('retrying').tone, 'warn');
  assert.equal(testResult(undefined), undefined);
  assert.equal(testResult(d('sent'))?.tone, 'ok');
  assert.equal(testResult(d('queued'))?.tone, 'info');
  const failed = testResult(d('failed', 'webhook_gone'));
  assert.equal(failed?.tone, 'bad');
  assert.ok(failed?.text.includes(describeOutcome('webhook_gone')));
  assert.equal(inFlight([d('sent'), d('retrying')]), true);
  assert.equal(inFlight([d('sent'), d('failed'), d('deferred')]), false);
});

test('help for both providers has four steps', () => {
  assert.equal(helpSteps.slack.length, 4);
  assert.equal(helpSteps.teams.length, 4);
});

test('the default rules match what the server gives a new destination', () => {
  const forms = defaultRouteForms([
    entry('release.live', 'releases', 'Releases'),
    entry('review.new', 'reviews', 'Reviews'),
    entry('release.halted', 'releases', 'Releases'),
  ]);
  assert.equal(forms.length, 2);
  assert.deepEqual(routeInputFrom(forms[0] as never), {
    alertTypes: ['*'],
    minSeverity: 'critical',
    appIds: null,
    platforms: null,
    enabled: true,
  });
  assert.deepEqual(routeInputFrom(forms[1] as never).alertTypes, [
    'release.live',
    'release.halted',
  ]);
  assert.equal(routeInputFrom(forms[1] as never).minSeverity, 'info');
});
