import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorkflowDispatch } from './services/workflow-inputs.ts';

const RELEASE = `name: iOS release # the name shown in the UI
run-name: Release \${{ inputs.version }} (build \${{ inputs.build_number }})

on:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      version:
        description: 'Marketing version, like 2.4.0'
        required: true
        type: string
      build_number:
        description: >
          The build number to upload.
          Must be higher than the last one.
        required: false
        default: "240"
      lane:
        type: choice
        description: Fastlane lane # not the track
        default: beta
        options:
          - beta
          - release
      dry_run:
        type: boolean
        default: false
      tags: {}
jobs:
  build:
    runs-on: macos-14
    steps:
      - uses: actions/checkout@v4
      - run: bundle exec fastlane \${{ inputs.lane }}
`;

test('reads the inputs of a workflow_dispatch trigger with their types and defaults', () => {
  const info = parseWorkflowDispatch(RELEASE);
  assert.equal(info.parsed, true);
  assert.equal(info.dispatchable, true);
  assert.deepEqual(info.inputs, [
    { name: 'version', description: 'Marketing version, like 2.4.0', required: true, type: 'string' },
    {
      name: 'build_number',
      description: 'The build number to upload. Must be higher than the last one.',
      required: false,
      default: '240',
      type: 'string',
    },
    {
      name: 'lane',
      description: 'Fastlane lane',
      required: false,
      default: 'beta',
      type: 'choice',
      options: ['beta', 'release'],
    },
    { name: 'dry_run', required: false, default: 'false', type: 'boolean' },
    { name: 'tags', required: false, type: 'string' },
  ]);
});

test('a workflow without inputs, with a flow list of triggers, or with a single trigger', () => {
  assert.deepEqual(parseWorkflowDispatch('on: [push, workflow_dispatch]\njobs: {}\n'), {
    dispatchable: true,
    parsed: true,
    inputs: [],
  });
  assert.equal(parseWorkflowDispatch('on: workflow_dispatch\n').dispatchable, true);
  assert.equal(parseWorkflowDispatch('on: push\n').dispatchable, false);
  assert.equal(parseWorkflowDispatch('on:\n  push:\n  pull_request:\n').dispatchable, false);
  assert.deepEqual(parseWorkflowDispatch('on:\n  workflow_dispatch:\n'), {
    dispatchable: true,
    parsed: true,
    inputs: [],
  });
});

test('quotes, apostrophes and # inside values are kept', () => {
  const info = parseWorkflowDispatch(
    [
      'on:',
      '  workflow_dispatch:',
      '    inputs:',
      '      note:',
      '        description: "Don\'t forget # the ticket"',
      "        default: 'it''s fine'",
      '      other:',
      "        description: Don't panic",
      '',
    ].join('\n'),
  );
  assert.equal(info.inputs[0]?.description, "Don't forget # the ticket");
  assert.equal(info.inputs[0]?.default, "it's fine");
  assert.equal(info.inputs[1]?.description, "Don't panic");
});

test('input names keep their case and may be quoted; a choice without a type is still a choice', () => {
  const info = parseWorkflowDispatch(
    'on:\n  workflow_dispatch:\n    inputs:\n      "Track":\n        options: [internal, beta]\n',
  );
  assert.deepEqual(info.inputs, [
    { name: 'Track', required: false, type: 'choice', options: ['internal', 'beta'] },
  ]);
});

test('Windows line endings and an unreadable file never throw', () => {
  assert.equal(parseWorkflowDispatch(RELEASE.replace(/\n/g, '\r\n')).inputs.length, 5);
  assert.deepEqual(parseWorkflowDispatch('on: &anchor\n  workflow_dispatch:\n'), {
    dispatchable: null,
    parsed: false,
    inputs: [],
  });
  assert.equal(parseWorkflowDispatch('::: not yaml :::\n\t- [').parsed, false);
  assert.equal(parseWorkflowDispatch('').parsed, false);
  assert.equal(parseWorkflowDispatch('name: x\n').dispatchable, false);
});
