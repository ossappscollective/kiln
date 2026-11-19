import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReleaseState } from '@mrm/core';
import { KNOWN_APP_STORE_STATES, mapAppStoreState, mapPlayTrackRelease } from './mappings.ts';

const appleTable: [string | null | undefined, ReleaseState | undefined][] = [
  // appVersionState (current)
  ['PREPARE_FOR_SUBMISSION', 'draft'],
  ['READY_FOR_REVIEW', 'ready'],
  ['DEVELOPER_REJECTED', 'draft'],
  ['WAITING_FOR_REVIEW', 'in_review'],
  ['IN_REVIEW', 'in_review'],
  ['REJECTED', 'rejected'],
  ['METADATA_REJECTED', 'rejected'],
  ['INVALID_BINARY', 'rejected'],
  ['PENDING_DEVELOPER_RELEASE', 'approved'],
  ['PENDING_APPLE_RELEASE', 'approved'],
  ['PROCESSING_FOR_DISTRIBUTION', 'rolling_out'],
  ['READY_FOR_DISTRIBUTION', 'live'],
  // deliberately not mapped
  ['WAITING_FOR_EXPORT_COMPLIANCE', undefined],
  ['REPLACED_WITH_NEW_VERSION', undefined],
  // appStoreState (deprecated) names
  ['PROCESSING_FOR_APP_STORE', 'rolling_out'],
  ['READY_FOR_SALE', 'live'],
  ['REMOVED_FROM_SALE', undefined],
  ['DEVELOPER_REMOVED_FROM_SALE', undefined],
  ['PENDING_CONTRACT', undefined],
  // unknown and malformed input is never guessed
  ['SOMETHING_NEW', undefined],
  ['', undefined],
  ['constructor', undefined],
  ['__proto__', undefined],
  [null, undefined],
  [undefined, undefined],
  // case and whitespace are tolerated
  ['  ready_for_distribution ', 'live'],
];

for (const [raw, expected] of appleTable) {
  test(`mapAppStoreState(${JSON.stringify(raw)}) is ${expected ?? 'undefined'}`, () => {
    assert.equal(mapAppStoreState(raw), expected);
  });
}

test('mapAppStoreState refines a live version by its phased release', () => {
  assert.equal(
    mapAppStoreState('READY_FOR_DISTRIBUTION', { phasedRelease: 'ACTIVE' }),
    'rolling_out',
  );
  assert.equal(mapAppStoreState('READY_FOR_DISTRIBUTION', { phasedRelease: 'PAUSED' }), 'halted');
  assert.equal(mapAppStoreState('READY_FOR_DISTRIBUTION', { phasedRelease: 'COMPLETE' }), 'live');
  assert.equal(mapAppStoreState('READY_FOR_DISTRIBUTION', { phasedRelease: 'INACTIVE' }), 'live');
  // The phased release only matters for a live version.
  assert.equal(mapAppStoreState('IN_REVIEW', { phasedRelease: 'ACTIVE' }), 'in_review');
  assert.equal(mapAppStoreState('SOMETHING_NEW', { phasedRelease: 'ACTIVE' }), undefined);
});

test('every Apple state in the table maps to a lifecycle state or an explicit undefined', () => {
  assert.ok(KNOWN_APP_STORE_STATES.length >= 20);
  for (const name of KNOWN_APP_STORE_STATES) {
    const result = mapAppStoreState(name);
    assert.ok(result === undefined || typeof result === 'string', name);
  }
});

const playTable: [
  string,
  { status: string | undefined; userFraction?: number | undefined },
  { state: ReleaseState; fraction?: number } | undefined,
][] = [
  ['draft', { status: 'draft' }, { state: 'draft' }],
  ['draft ignores a stray fraction', { status: 'draft', userFraction: 0.5 }, { state: 'draft' }],
  [
    'inProgress with fraction',
    { status: 'inProgress', userFraction: 0.2 },
    { state: 'rolling_out', fraction: 0.2 },
  ],
  ['inProgress without fraction', { status: 'inProgress' }, { state: 'rolling_out' }],
  [
    'inProgress with nonsense fraction',
    { status: 'inProgress', userFraction: 0 },
    { state: 'rolling_out' },
  ],
  [
    'inProgress with fraction above 1',
    { status: 'inProgress', userFraction: 1.5 },
    { state: 'rolling_out' },
  ],
  [
    'inProgress with NaN fraction',
    { status: 'inProgress', userFraction: Number.NaN },
    { state: 'rolling_out' },
  ],
  [
    'halted keeps its fraction',
    { status: 'halted', userFraction: 0.5 },
    { state: 'halted', fraction: 0.5 },
  ],
  ['halted without fraction', { status: 'halted' }, { state: 'halted' }],
  ['completed', { status: 'completed' }, { state: 'live' }],
  ['completed ignores fraction', { status: 'completed', userFraction: 0.5 }, { state: 'live' }],
  ['statusUnspecified', { status: 'statusUnspecified' }, undefined],
  ['missing status', { status: undefined }, undefined],
  ['a status added later', { status: 'underReview' }, undefined],
  ['wrong case is not guessed', { status: 'INPROGRESS' }, undefined],
];

for (const [name, input, expected] of playTable) {
  test(`mapPlayTrackRelease: ${name}`, () => {
    assert.deepEqual(mapPlayTrackRelease(input), expected);
  });
}
