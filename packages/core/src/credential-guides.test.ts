import assert from 'node:assert/strict';
import { test } from 'node:test';
import { credentialKinds } from './credentials.ts';
import { credentialGuides, guideFor } from './credential-guides.ts';
import type { CredentialGuide } from './credential-guides.ts';

const allowedHosts = new Set([
  'developer.apple.com',
  'appstoreconnect.apple.com',
  'support.google.com',
  'developers.google.com',
  'cloud.google.com',
  'console.cloud.google.com',
  'docs.github.com',
  'github.com',
  'docs.cloud.google.com',
  'developers.deepl.com',
  'learn.microsoft.com',
  'portal.azure.com',
  'docs.libretranslate.com',
  'platform.claude.com',
  'developers.openai.com',
  'docs.ollama.com',
  'lmstudio.ai',
  'docs.vllm.ai',
]);

const verbs = new Set([
  'Check',
  'Request',
  'Open',
  'Generate',
  'Choose',
  'Download',
  'Copy',
  'Enter',
  'Create',
  'Enable',
  'Invite',
  'Grant',
  'Start',
  'Turn',
  'Set',
  'Install',
  'Select',
  'Wait',
]);

const sentences = (text: string) => text.split(/[.!?](?:\s+|$)/).filter((part) => part.trim());

function allTexts(guide: CredentialGuide): string[] {
  return [
    guide.summary,
    ...guide.prerequisites,
    ...guide.permissions,
    ...guide.steps.flatMap((s) => [s.title, s.body, s.link?.label ?? '']),
    ...guide.troubleshooting.flatMap((t) => [t.problem, t.fix]),
    ...guide.links.map((l) => l.label),
  ].filter(Boolean);
}

function allUrls(guide: CredentialGuide): string[] {
  return [
    ...guide.links.map((l) => l.url),
    ...guide.steps.flatMap((s) => (s.link ? [s.link.url] : [])),
  ];
}

test('there is a guide for every credential kind, and guideFor returns it', () => {
  for (const kind of credentialKinds) {
    assert.ok(credentialGuides[kind], kind);
    assert.equal(guideFor(kind), credentialGuides[kind]);
  }
});

for (const kind of credentialKinds) {
  const guide = credentialGuides[kind];

  test(`${kind}: has the required content`, () => {
    assert.ok(guide.summary.trim());
    assert.ok(guide.prerequisites.length >= 1);
    assert.ok(guide.steps.length >= 5 && guide.steps.length <= 10);
    assert.ok(guide.permissions.length >= 1);
    assert.ok(guide.troubleshooting.length >= 4);
    assert.ok(guide.links.length >= 2);
    for (const item of guide.troubleshooting) {
      assert.ok(item.problem.trim() && item.fix.trim());
    }
  });

  test(`${kind}: every URL is https on a vendor host`, () => {
    for (const raw of allUrls(guide)) {
      const url = new URL(raw);
      assert.equal(url.protocol, 'https:', raw);
      assert.ok(allowedHosts.has(url.hostname), `${raw} is not on the allowlist`);
    }
  });

  test(`${kind}: checkedOn is a valid ISO date`, () => {
    assert.match(guide.checkedOn, /^\d{4}-\d{2}-\d{2}$/);
    const date = new Date(`${guide.checkedOn}T00:00:00Z`);
    assert.ok(!Number.isNaN(date.getTime()));
    assert.equal(date.toISOString().slice(0, 10), guide.checkedOn);
  });

  test(`${kind}: step bodies are short`, () => {
    for (const step of guide.steps) {
      assert.ok(step.body.length <= 300, `${step.title}: ${step.body.length} characters`);
      assert.ok(sentences(step.body).length <= 2, `${step.title}: more than two sentences`);
    }
  });

  test(`${kind}: wording rules`, () => {
    for (const text of allTexts(guide)) {
      assert.ok(!/\b(simply|just)\b/i.test(text), `forbidden word in: ${text}`);
      assert.ok(!/[*`#]|\]\(/.test(text), `markup in: ${text}`);
    }
    for (const step of guide.steps) {
      assert.match(step.title, /^[A-Z][a-z]+\b/, step.title);
      assert.ok(verbs.has(step.title.split(' ')[0]!), `not a known verb: ${step.title}`);
    }
  });
}
