import { createHash } from 'node:crypto';
import {
  axmlManifest,
  binaryPlist,
  infoPlist,
  protoManifest,
} from '../modules/builds/artifact-meta/fixtures.ts';
import { crc32 } from '../services/png-codec.ts';

/**
 * The tiny files of the demo's workflow artifacts. Every artifact is a real, valid zip of a few hundred bytes, so the
 * download, the checksum and the Google Play internal app sharing flow can run end to end without anything large.
 * Nothing here is a real app binary: the .apk, .aab and .ipa hold only a manifest or an Info.plist with the version and the build
 * number (made by the test fixture builders), so "Reading the build number" works in the demo like on a real artifact.
 */

const text = new TextEncoder();

export type ZipFile = { name: string; data: Uint8Array };

/** A zip with stored (not compressed) entries, a real CRC and the usual central directory. */
export function storedZip(files: ZipFile[]): Uint8Array {
  const chunks: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const le = (n: number, bytes: number) =>
    Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff);
  for (const f of files) {
    const name = Array.from(text.encode(f.name));
    const crc = crc32(f.data);
    const head = [
      ...le(20, 2),
      ...le(0, 2),
      ...le(0, 2),
      ...le(0, 2),
      ...le(0x21, 2),
      ...le(crc, 4),
      ...le(f.data.length, 4),
      ...le(f.data.length, 4),
      ...le(name.length, 2),
      ...le(0, 2),
    ];
    chunks.push([...le(0x04034b50, 4), ...head, ...name, ...Array.from(f.data)]);
    central.push([
      ...le(0x02014b50, 4),
      ...le(20, 2),
      ...head,
      ...le(0, 2),
      ...le(0, 2),
      ...le(0, 2),
      ...le(0, 4),
      ...le(offset, 4),
      ...name,
    ]);
    offset += 30 + name.length + f.data.length;
  }
  const dir = central.flat();
  const end = [
    ...le(0x06054b50, 4),
    ...le(0, 2),
    ...le(0, 2),
    ...le(files.length, 2),
    ...le(files.length, 2),
    ...le(dir.length, 4),
    ...le(offset, 4),
    ...le(0, 2),
  ];
  return new Uint8Array([...chunks.flat(), ...dir, ...end]);
}

export type ArtifactKind = 'ipa' | 'apk' | 'aab' | 'dmg';

/** The zip of one demo artifact: an .ipa/.dmg holds a stub payload, an .apk/.aab is the file Google Play would take. */
export function artifactZip(input: {
  name: string;
  kind: ArtifactKind;
  appName: string;
  /** The bundle id or package name. */
  identifier: string;
  version: string;
  build: string;
}): Uint8Array {
  const note = (what: string) =>
    text.encode(
      `${what}\nDemo file: made up by demo mode, not a real build.\n${input.appName} ${input.version} (${input.build})\n`,
    );
  const code = Number.parseInt(input.build, 10);
  if (input.kind === 'ipa')
    return storedZip([
      {
        name: `Payload/${input.appName.replace(/\s+/g, '')}.app/Info.plist`,
        data: binaryPlist(
          infoPlist({
            buildNumber: input.build,
            version: input.version,
            bundleId: input.identifier,
            name: input.appName,
          }),
        ),
      },
    ]);
  if (input.kind === 'dmg')
    return storedZip([
      { name: `${input.appName.replace(/\s+/g, '')}.dmg`, data: note('Demo disk image') },
    ]);
  const manifest = {
    versionCode: Number.isFinite(code) ? code : 1,
    versionName: input.version,
    packageName: input.identifier,
  };
  const aab = input.kind === 'aab';
  return storedZip([
    {
      name: input.name,
      // The build file is itself a small zip: the manifest of an APK, or the base module manifest of a bundle.
      data: storedZip([
        aab
          ? { name: 'base/manifest/AndroidManifest.xml', data: protoManifest(manifest) }
          : { name: 'AndroidManifest.xml', data: axmlManifest(manifest) },
        { name: 'DEMO.txt', data: note(aab ? 'Demo Android App Bundle' : 'Demo Android package') },
      ]),
    },
  ]);
}

export const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
