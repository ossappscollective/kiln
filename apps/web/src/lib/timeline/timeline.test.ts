import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TimelineEvent } from '@kiln/core';
import {
  MAX_MARKERS,
  MARKER_LINES,
  PAGE_SIZE,
  type TimelineEntry,
  entriesOf,
  eventHref,
  eventText,
  filterEntries,
  groupByDay,
  kindCounts,
  manualId,
  markersFor,
  pageOf,
  sortEntries,
  toggleKind,
  windowFor,
  withTimelineSection,
} from './timeline.ts';
import { loadShowEvents, markersKey, saveShowEvents } from './markers-pref.ts';

const kiln = (id: string, day: string, kind: TimelineEvent['kind'], code: string, params: Record<string, string | number> = {}, extra: Partial<TimelineEvent> = {}): TimelineEvent => ({
  id, day, kind, origin: 'kiln', label: { code, params }, title: null, note: null, version: null, liveDay: null, waitsForRelease: false, ...extra,
});
const manual = (id: string, day: string, title: string, kind: TimelineEvent['kind'] = 'other'): TimelineEvent => ({
  id: `m:${id}`, day, kind, origin: 'manual', label: null, title, note: null, version: null, liveDay: null, waitsForRelease: false,
});
const ios = { id: 'a1', platform: 'ios' as const };
const android = { id: 'a2', platform: 'android' as const };

test('no events: every view is empty and nothing throws', () => {
  const entries = entriesOf([{ app: ios, events: [] }]);
  assert.deepEqual(entries, []);
  assert.deepEqual(kindCounts(entries), []);
  assert.deepEqual(groupByDay(entries), []);
  assert.deepEqual(pageOf(entries, PAGE_SIZE), { groups: [], shown: 0, rest: 0 });
  assert.deepEqual(markersFor(entries, ['2026-11-01']), { markers: [], hidden: 0 });
});

test('events read as sentences: Kiln codes are translated, a person title is kept as written', () => {
  assert.equal(eventText(kiln('k:release:1', '2026-11-01', 'release', 'release', { version: '2.1.0' })), 'Version 2.1.0 released');
  assert.equal(eventText(kiln('k:release:1', '2026-11-01', 'release', 'release', { version: '2.1.0', track: 'production' })), 'Version 2.1.0 released on production');
  assert.equal(eventText(kiln('k:step:1', '2026-11-01', 'rollout', 'rolloutStep', { version: '2.1.0', percent: 25 })), 'Rollout of 2.1.0 reached 25%');
  assert.equal(eventText(kiln('k:push:1:graphics', '2026-11-01', 'graphics', 'graphics', { count: 1 })), '1 graphics set pushed to the store draft');
  assert.equal(eventText(kiln('k:push:1:graphics', '2026-11-01', 'graphics', 'graphics', { count: 3 })), '3 graphics sets pushed to the store draft');
  assert.equal(eventText(kiln('k:exp:1:start', '2026-11-01', 'experiment_started', 'experimentStarted', { name: 'Icon A' })), 'Experiment started: Icon A');
  assert.equal(eventText(manual('1', '2026-11-01', 'Ad burst <b>x</b>', 'ad_campaign')), 'Ad burst <b>x</b>');
  // A code this version does not know reads as its kind, never as raw code.
  assert.equal(eventText(kiln('k:x', '2026-11-01', 'release', 'somethingNew')), 'Release');
});

test('links point at the object of the event; a person note has none', () => {
  const entry = (e: TimelineEvent): TimelineEntry => ({ ...e, appId: 'a1', platform: 'ios' });
  assert.equal(eventHref(entry(kiln('k:release:1', '2026-11-01', 'release', 'release', { version: '2.1.0' }, { version: '2.1.0' }))), '#/portfolio/a1/release/2.1.0?platform=ios');
  assert.equal(eventHref(entry(kiln('k:release:1', '2026-11-01', 'release', 'release'))), '#/portfolio/a1/releases?platform=ios');
  assert.equal(eventHref(entry(kiln('k:p', '2026-11-01', 'graphics', 'graphics'))), '#/portfolio/a1/listing?platform=ios&view=graphics');
  assert.equal(eventHref(entry(kiln('k:p', '2026-11-01', 'listing_text', 'listingText'))), '#/portfolio/a1/listing?platform=ios');
  assert.equal(eventHref(entry(kiln('k:e', '2026-11-01', 'experiment_ended', 'experimentEnded'))), '#/portfolio/a1/insights?platform=ios&view=experiments');
  assert.equal(eventHref(entry(manual('1', '2026-11-01', 'Press'))), null);
});

test('events of two platforms are one list, newest day first, stable inside a day', () => {
  const list = entriesOf([
    { app: ios, events: [kiln('k:release:1', '2026-11-01', 'release', 'release', { version: '1' }), manual('1', '2026-11-03', 'Launch post', 'press')] },
    { app: android, events: [kiln('k:release:1', '2026-11-01', 'release', 'release', { version: '1' })] },
  ]);
  assert.deepEqual(list.map((e) => `${e.day}:${e.platform}`), ['2026-11-03:ios', '2026-11-01:android', '2026-11-01:ios']);
  assert.deepEqual(sortEntries(list).map((e) => e.id), list.map((e) => e.id));
});

test('filters: none pressed is every kind, chips only for kinds that occur, toggling does not mutate', () => {
  const list = entriesOf([{ app: ios, events: [kiln('a', '2026-11-01', 'release', 'release'), kiln('b', '2026-11-02', 'graphics', 'graphics'), manual('1', '2026-11-02', 'x', 'press')] }]);
  assert.deepEqual(kindCounts(list), [{ kind: 'release', count: 1 }, { kind: 'graphics', count: 1 }, { kind: 'press', count: 1 }]);
  assert.equal(filterEntries(list, new Set()).length, 3);
  const one = toggleKind(new Set(), 'press');
  assert.deepEqual([...one], ['press']);
  assert.equal(filterEntries(list, one).length, 1);
  assert.deepEqual([...toggleKind(one, 'press')], []);
  assert.equal(filterEntries(list, new Set(['experiment_ended'] as const)).length, 0);
});

test('a same-day burst is one group, and thousands of events are paged without splitting the order', () => {
  const events = Array.from({ length: 2500 }, (_v, i) => manual(String(i), i < 1000 ? '2026-11-05' : `2026-10-${String(1 + (i % 28)).padStart(2, '0')}`, `n${i}`));
  const list = entriesOf([{ app: ios, events }]);
  const first = pageOf(list, PAGE_SIZE);
  assert.equal(first.shown, PAGE_SIZE);
  assert.equal(first.rest, 2500 - PAGE_SIZE);
  assert.equal(first.groups.length, 1);
  assert.equal(first.groups[0]?.entries.length, PAGE_SIZE);
  assert.equal(pageOf(list, 10_000).rest, 0);
  assert.equal(pageOf(list, -5).shown, 0);
});

test('markers: only visible days, one per day with a count, capped, and the busiest days stay', () => {
  const dates = Array.from({ length: 60 }, (_v, i) => `2026-11-${String(1 + i).padStart(2, '0')}`).filter((d) => d <= '2026-11-30');
  const events = [
    kiln('a', '2026-11-03', 'release', 'release', { version: '1' }),
    kiln('b', '2026-11-03', 'graphics', 'graphics', { count: 2 }),
    manual('1', '2026-11-03', 'One'),
    manual('2', '2026-11-03', 'Two'),
    manual('3', '2026-10-01', 'Before the chart'),
  ];
  const { markers, hidden } = markersFor(events, dates);
  assert.equal(hidden, 0);
  assert.equal(markers.length, 1);
  assert.equal(markers[0]?.i, 2);
  assert.equal(markers[0]?.count, 4);
  assert.equal(markers[0]?.lines.length, MARKER_LINES);
  assert.equal(markers[0]?.more, 1);
  // One event on every day of a 30-day chart, one day with three: the cap keeps the busy day.
  const everyDay = dates.map((d, i) => manual(`d${i}`, d));
  const busy = [manual('x', '2026-11-10', 'x'), manual('y', '2026-11-10', 'y')];
  const capped = markersFor([...everyDay, ...busy], dates, 5);
  assert.equal(capped.markers.length, 5);
  assert.equal(capped.hidden, dates.length - 5);
  assert.ok(capped.markers.some((m) => m.day === '2026-11-10' && m.count === 3));
  assert.deepEqual(capped.markers.map((m) => m.i), [...capped.markers.map((m) => m.i)].sort((a, b) => a - b));
  assert.ok(MAX_MARKERS >= 10);
});

test('the range is cut to what the API reads', () => {
  assert.deepEqual(windowFor('2026-11-01', '2026-11-28'), { from: '2026-11-01', to: '2026-11-28', cut: false });
  const w = windowFor('2024-01-01', '2026-11-28');
  assert.equal(w.cut, true);
  assert.equal(w.to, '2026-11-28');
  assert.equal(w.from, '2025-11-14');
});

test('addresses and ids', () => {
  assert.equal(withTimelineSection('#/portfolio/a1/insights?view=timeline&section=reports&platform=ios', 'events'), '#/portfolio/a1/insights?view=timeline&platform=ios');
  assert.equal(withTimelineSection('#/portfolio/a1/insights?range=28', 'reports'), '#/portfolio/a1/insights?range=28&view=timeline&section=reports');
  assert.equal(manualId({ id: 'm:abc' }), 'abc');
  assert.equal(manualId({ id: 'abc' }), 'abc');
});

test('"Show events" is remembered per person and never throws without storage', () => {
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  assert.equal(loadShowEvents('u1', store), false);
  saveShowEvents('u1', true, store);
  assert.equal(loadShowEvents('u1', store), true);
  assert.equal(loadShowEvents('u2', store), false);
  assert.notEqual(markersKey('u1'), markersKey('u2'));
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('full'); } };
  assert.equal(loadShowEvents('u1', broken), false);
  assert.doesNotThrow(() => saveShowEvents('u1', true, broken));
  assert.equal(loadShowEvents('u1', null), false);
});
