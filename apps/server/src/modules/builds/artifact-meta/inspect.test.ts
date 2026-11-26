import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { AxmlError, readManifestAxml } from './axml.ts';
import {
  axmlManifest,
  binaryPlist,
  infoPlist,
  protoManifest,
  xmlPlist,
  zipOf,
} from './fixtures.ts';
import { inspectBuildArtifact } from './inspect.ts';
import { parsePlist } from './plist.ts';
import { readManifestProto } from './proto-manifest.ts';
import { openZipBuffer, openZipFile, ZipError } from './zip-file.ts';

// Every file here is assembled by hand from the documented layouts (see fixtures.ts). NO real
// APK, AAB or IPA was available to test with, so these tests prove that the reader and the
// builders agree, not that real store files parse.

const APK = axmlManifest({ versionCode: 167, versionName: '1.26.2', packageName: 'com.acme.app' });
const AAB = protoManifest({ versionCode: 167, versionName: '1.26.2', packageName: 'com.acme.app' });
const PLIST = binaryPlist(
  infoPlist({ buildNumber: '167', version: '1.26.2', bundleId: 'com.acme.app' }),
);
const apkZip = () => zipOf([{ name: 'AndroidManifest.xml', data: APK, method: 'deflate' }]);
const aabZip = () =>
  zipOf([{ name: 'base/manifest/AndroidManifest.xml', data: AAB, method: 'deflate' }]);
const ipaZip = (plist: Buffer = PLIST) =>
  zipOf([
    { name: 'Payload/', data: '' },
    { name: 'Payload/App.app/Info.plist', data: plist, method: 'deflate' },
    {
      name: 'Payload/App.app/Watch/W.app/Info.plist',
      data: binaryPlist(infoPlist({ buildNumber: '1' })),
    },
  ]);
const EXPECTED = { buildNumber: '167', version: '1.26.2', packageId: 'com.acme.app' };

const scratch = async <T>(use: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'kiln-meta-test-'));
  try {
    return await use(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

/** Writes a number into the first central directory header of a zip (a lie in the header). */
function patchCentral(zip: Buffer, offset: number, value: number): Buffer {
  const out = Buffer.from(zip);
  const at = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  out.writeUInt32LE(value, at + offset);
  return out;
}

test('zip: stored and deflate entries read from memory and from a file; directories are skipped', async () => {
  const zip = zipOf([
    { name: 'dir/', data: '' },
    { name: 'a.txt', data: 'hello' },
    { name: 'dir/b.txt', data: 'x'.repeat(5000), method: 'deflate' },
  ]);
  const memory = await openZipBuffer(zip);
  assert.deepEqual(
    memory.entries.map((e) => [e.name, e.method, e.size]),
    [
      ['a.txt', 0, 5],
      ['dir/b.txt', 8, 5000],
    ],
  );
  const b = memory.find((n) => n === 'dir/b.txt');
  assert.ok(b);
  assert.equal((await memory.read(b, 10_000)).toString(), 'x'.repeat(5000));
  await scratch(async (dir) => {
    const path = join(dir, 'a.zip');
    await writeFile(path, zip);
    const file = await openZipFile(path);
    const a = file.find((n) => n === 'a.txt');
    assert.ok(a);
    assert.equal((await file.read(a, 100)).toString(), 'hello');
    await file.close();
  });
});

test('zip: garbage, truncation, zip64, encryption and unsupported methods fail with a clear code', async () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof ZipError ? e.code : `other: ${e}`),
    );
  const junk = Buffer.from('not a zip at all, but long enough......');
  assert.equal(await code(openZipBuffer(junk)), 'bad_zip');
  assert.equal(await code(openZipBuffer(Buffer.alloc(0))), 'bad_zip');
  const zip = zipOf([{ name: 'a.txt', data: 'hello' }]);
  assert.equal(await code(openZipBuffer(zip.subarray(0, zip.length - 10))), 'bad_zip');
  const zip64 = Buffer.from(zip);
  zip64.writeUInt16LE(0xffff, zip64.length - 22 + 10);
  assert.equal(await code(openZipBuffer(zip64)), 'zip64');
  const encrypted = Buffer.from(zip);
  encrypted.writeUInt16LE(1, encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
  const enc = await openZipBuffer(encrypted);
  const [entry] = enc.entries;
  assert.ok(entry);
  assert.equal(await code(enc.read(entry, 100)), 'encrypted');
  const odd = await openZipBuffer(patchMethod(zip, 12));
  const [oddEntry] = odd.entries;
  assert.ok(oddEntry);
  assert.equal(await code(odd.read(oddEntry, 100)), 'unsupported_method');
});

function patchMethod(zip: Buffer, method: number): Buffer {
  const out = Buffer.from(zip);
  out.writeUInt16LE(method, out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
  return out;
}

test('zip: an entry over the cap, a bomb by ratio and a header that lies about the size are refused', async () => {
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e) => (e instanceof ZipError ? e.code : `other: ${e}`),
    );
  const big = zipOf([{ name: 'big.bin', data: 'y'.repeat(3000), method: 'deflate' }]);
  const archive = await openZipBuffer(big);
  const [entry] = archive.entries;
  assert.ok(entry);
  assert.equal(await code(archive.read(entry, 1000)), 'too_large');
  assert.equal((await archive.read(entry, 3000)).length, 3000);

  // 4 MB of zeros deflate to a few KB: far over the ratio, refused before inflating anything.
  const zeros = zipOf([{ name: 'z.bin', data: Buffer.alloc(4 * 1024 * 1024), method: 'deflate' }]);
  const bomb = await openZipBuffer(zeros);
  const [z] = bomb.entries;
  assert.ok(z);
  assert.ok(z.size > z.compressedSize * 200);
  assert.equal(await code(bomb.read(z, 64 * 1024 * 1024)), 'bomb');

  // The header says 10 bytes, the stream inflates to 3000: the inflate stops at what was declared.
  const liar = await openZipBuffer(patchCentral(big, 24, 10));
  const [l] = liar.entries;
  assert.ok(l);
  assert.equal(await code(liar.read(l, 1000)), 'bomb');
  assert.equal(
    await code(
      scratch(async (dir) => {
        await liar.extractToFile(l, join(dir, 'out'), 1000);
      }),
    ),
    'bomb',
  );
});

test('axml: versionCode, versionName and package from UTF-16 and UTF-8 pools, with and without resource ids', () => {
  const variants = [{}, { utf8: true }, { resourceIds: true }, { utf8: true, resourceIds: true }];
  for (const options of variants) {
    const fields = { versionCode: 4_000_001, versionName: 'é-1', packageName: 'a.b' };
    assert.deepEqual(
      readManifestAxml(axmlManifest({ ...fields, ...options })),
      { versionCode: '4000001', versionName: 'é-1', packageName: 'a.b' },
      JSON.stringify(options),
    );
  }
  assert.deepEqual(readManifestAxml(axmlManifest({ versionCode: 5 })), {
    versionCode: '5',
    versionName: null,
    packageName: null,
  });
  assert.equal(readManifestAxml(axmlManifest({ root: 'application', versionCode: 5 })), null);
});

test('axml: not binary XML or cut short is an error, never a wrong number', () => {
  assert.throws(() => readManifestAxml(Buffer.from('<manifest/>')), AxmlError);
  assert.throws(() => readManifestAxml(Buffer.alloc(3)), AxmlError);
  const full = axmlManifest({ versionCode: 9, versionName: '1', packageName: 'a.b' });
  for (const cut of [10, 40, 80, full.length - 30]) {
    try {
      const got = readManifestAxml(full.subarray(0, cut));
      const said = `cut at ${cut} gave ${JSON.stringify(got)}`;
      assert.ok(got === null || got.versionCode === null, said);
    } catch (error) {
      assert.ok(error instanceof AxmlError || error instanceof RangeError);
    }
  }
});

test('protobuf manifest: the text of the attribute, or the compiled integer when there is no text', () => {
  const fields = { versionCode: 167, versionName: '1.26.2', packageName: 'a.b' };
  assert.deepEqual(readManifestProto(protoManifest(fields)), {
    versionCode: '167',
    versionName: '1.26.2',
    packageName: 'a.b',
  });
  const code = (f: Parameters<typeof protoManifest>[0]) =>
    readManifestProto(protoManifest(f))?.versionCode;
  assert.equal(code({ versionCode: 168, compiledOnly: true }), '168');
  assert.equal(code({ versionCode: 2_100_000_000 }), '2100000000');
  assert.equal(readManifestProto(protoManifest({ root: 'application', versionCode: 1 })), null);
  assert.throws(() => readManifestProto(Buffer.from([0x0a, 0xff, 0x01])));
  // A group wire type is not understood.
  assert.throws(() => readManifestProto(Buffer.from([0x0b])));
});

test('plist: the binary and the XML form give the same values; long and non ASCII strings, nesting, booleans', () => {
  const value = {
    CFBundleVersion: '167',
    CFBundleShortVersionString: '1.26.2',
    Name: 'Café ☕ with a name long enough to need a length object',
    Count: 70_000,
    Small: 3,
    Flag: false,
    List: ['a', 2, true, { k: 'v' }],
  };
  for (const bytes of [binaryPlist(value), xmlPlist(value)]) {
    // Dictionaries have no prototype: compare as plain JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(parsePlist(bytes))), value);
  }
  const xml = [
    '<?xml version="1.0"?><!-- c --><plist version="1.0"><dict>',
    '<key>A &amp; B</key><string>x &lt;&#65;&#x42;&gt;</string>',
    '<key>E</key><string/></dict></plist>',
  ].join('');
  const entities = parsePlist(Buffer.from(xml)) as Record<string, string>;
  assert.equal(entities['A & B'], 'x <AB>');
  assert.equal(entities.E, '');
  assert.throws(() => parsePlist(Buffer.from('<plist><dict><key>a</key></dict></plist>')));
  const notPlist = Buffer.from('bplist00 and then nothing useful at all here........');
  assert.throws(() => parsePlist(notPlist));
  assert.throws(() => parsePlist(Buffer.from(`<plist>${'<array>'.repeat(100)}</plist>`)));
  const cut = binaryPlist(value);
  assert.throws(() => parsePlist(cut.subarray(0, cut.length - 5)));
});

test('inspect: an APK, an AAB and an IPA, each as the artifact itself', async () => {
  assert.deepEqual(await inspectBuildArtifact(apkZip()), { ...EXPECTED, format: 'apk' });
  assert.deepEqual(await inspectBuildArtifact(aabZip()), { ...EXPECTED, format: 'aab' });
  assert.deepEqual(await inspectBuildArtifact(ipaZip()), { ...EXPECTED, format: 'ipa' });
});

test('inspect: the XML plist and the .app or .xcarchive folder zipped directly', async () => {
  const xml = xmlPlist(infoPlist({ buildNumber: '88', version: '2.0', bundleId: 'com.x.y' }));
  const want = { buildNumber: '88', version: '2.0', packageId: 'com.x.y', format: 'ipa' };
  for (const name of ['Payload/X.app/Info.plist', 'X.app/Info.plist']) {
    assert.deepEqual(await inspectBuildArtifact(zipOf([{ name, data: xml }])), want, name);
  }
  assert.deepEqual(
    await inspectBuildArtifact(
      zipOf([
        {
          name: 'X.xcarchive/Info.plist',
          data: binaryPlist({ ApplicationProperties: { CFBundleVersion: '1' } }),
        },
        { name: 'X.xcarchive/Products/Applications/X.app/Info.plist', data: xml },
      ]),
    ),
    want,
  );
});

test('inspect: a build file inside the artifact, stored or deflated, among other files', async () => {
  for (const method of ['store', 'deflate'] as const) {
    const outer = zipOf([
      { name: 'README.txt', data: 'built by CI' },
      { name: 'build/app-release.apk', data: apkZip(), method },
    ]);
    assert.deepEqual(await inspectBuildArtifact(outer), { ...EXPECTED, format: 'apk' }, method);
    const aab = zipOf([{ name: 'app.aab', data: aabZip(), method }]);
    assert.deepEqual(await inspectBuildArtifact(aab), { ...EXPECTED, format: 'aab' }, method);
    const ipa = zipOf([{ name: 'App.ipa', data: ipaZip(), method }]);
    assert.deepEqual(await inspectBuildArtifact(ipa), { ...EXPECTED, format: 'ipa' }, method);
  }
});

test('inspect: several build files, the first one that can be read is the answer; unreadable ones are passed over', async () => {
  const outer = zipOf([
    { name: 'broken.apk', data: 'not a zip' },
    { name: 'empty.aab', data: zipOf([{ name: 'x', data: 'y' }]) },
    { name: 'good.apk', data: apkZip() },
  ]);
  assert.deepEqual(await inspectBuildArtifact(outer), { ...EXPECTED, format: 'apk' });
});

test('inspect: from a file path; a big deflated build file goes through a temporary file that is deleted', async () => {
  const filler = Buffer.from(Array.from({ length: 200_000 }, (_, i) => (i * 7919) % 251));
  const inner = zipOf([
    { name: 'AndroidManifest.xml', data: APK, method: 'deflate' },
    { name: 'classes.dex', data: filler, method: 'store' },
  ]);
  const outer = zipOf([{ name: 'app-release.apk', data: inner, method: 'deflate' }]);
  await scratch(async (dir) => {
    const path = join(dir, 'artifact.zip');
    await writeFile(path, outer);
    assert.deepEqual(await inspectBuildArtifact(path), { ...EXPECTED, format: 'apk' });
    // Over the memory cap: it needs the temp folder.
    const small = { maxMemoryBytes: 1000 };
    assert.equal(await inspectBuildArtifact(path, small), null, 'no temp folder, no answer');
    const temp = join(dir, 'tmp');
    await mkdir(temp);
    assert.deepEqual(await inspectBuildArtifact(path, { ...small, tempDir: temp }), {
      ...EXPECTED,
      format: 'apk',
    });
    assert.deepEqual(await readdir(temp), [], 'the temporary file is gone');
    assert.equal(
      await inspectBuildArtifact(path, { ...small, tempDir: temp, maxFileBytes: 1000 }),
      null,
      'over the file cap',
    );
    assert.deepEqual(await readdir(temp), []);
  });
});

test('inspect: nothing recognised is null: no build file, no manifest, no build number, wrong plist', async () => {
  assert.equal(await inspectBuildArtifact(zipOf([{ name: 'report.txt', data: 'x' }])), null);
  assert.equal(await inspectBuildArtifact(zipOf([])), null);
  const noCode = zipOf([{ name: 'AndroidManifest.xml', data: axmlManifest({ versionName: '1' }) }]);
  assert.equal(await inspectBuildArtifact(noCode), null, 'a manifest without a versionCode');
  assert.equal(
    await inspectBuildArtifact(ipaZip(binaryPlist({ CFBundleShortVersionString: '1.0' }))),
    null,
    'a plist without CFBundleVersion',
  );
  assert.equal(await inspectBuildArtifact(ipaZip(Buffer.from('garbage'))), null);
  assert.equal(await inspectBuildArtifact(Buffer.from('garbage')), null);
  assert.equal(await inspectBuildArtifact('/nonexistent/file.zip'), null);
  const nested = zipOf([{ name: 'a.ipa', data: zipOf([{ name: 'b.ipa', data: ipaZip() }]) }]);
  assert.equal(await inspectBuildArtifact(nested), null, 'only one level of nesting is opened');
  // An integer CFBundleVersion is a number too.
  assert.equal(
    (await inspectBuildArtifact(ipaZip(xmlPlist({ CFBundleVersion: 12 }))))?.buildNumber,
    '12',
  );
});

test('inspect: a bomb inside the artifact is refused, and nothing throws', async () => {
  const bomb = zipOf([{ name: 'app.apk', data: Buffer.alloc(8 * 1024 * 1024), method: 'deflate' }]);
  assert.equal(await inspectBuildArtifact(bomb), null);
  const lying = patchCentral(
    zipOf([{ name: 'app.apk', data: apkZip(), method: 'deflate' }]),
    24,
    5,
  );
  assert.equal(await inspectBuildArtifact(lying), null);
});

test('inspect: random and damaged input never throws and never gives a malformed answer', async () => {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed;
  };
  const valid = [
    zipOf([{ name: 'a.apk', data: apkZip(), method: 'deflate' }]),
    zipOf([{ name: 'a.ipa', data: ipaZip() }]),
    zipOf([{ name: 'a.aab', data: aabZip() }]),
  ];
  const check = (got: unknown) => {
    if (got === null) return;
    const g = got as { buildNumber: unknown; format: unknown };
    assert.equal(typeof g.buildNumber, 'string');
    assert.ok(['apk', 'aab', 'ipa'].includes(String(g.format)));
  };
  for (let n = 0; n < 150; n += 1) {
    const source = Buffer.from(valid[n % valid.length] as Buffer);
    for (let k = 0; k < 1 + (n % 4); k += 1) source[next() % source.length] = next() & 0xff;
    const cut = n % 5 === 0 ? source.subarray(0, next() % source.length) : source;
    check(await inspectBuildArtifact(cut));
  }
  for (let n = 0; n < 50; n += 1) {
    const random = Buffer.alloc(1 + (next() % 400));
    for (let i = 0; i < random.length; i += 1) random[i] = next() & 0xff;
    check(await inspectBuildArtifact(random));
  }
  // An unrelated deflate stream where a build file should be.
  check(
    await inspectBuildArtifact(
      zipOf([{ name: 'x.apk', data: deflateRawSync(Buffer.from('plain')), method: 'store' }]),
    ),
  );
});
