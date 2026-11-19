import { deflateRawSync, gzipSync } from 'node:zlib';

/**
 * Synthetic search terms files (made-up numbers and invented terms). The columns of `traffic_source` are the ones Google documents
 * (docs/research/play-search-terms.md); the other shapes (a console export per day, a period export with no dates, a localised
 * number format) are guesses at what "Export report" gives and are marked UNVERIFIED in the research note.
 */

export const csv = (rows: string[][], delimiter = ','): string =>
  `${rows
    .map((r) => r.map((c) => (/[",\t\n;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(delimiter))
    .join('\r\n')}\r\n`;

export const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** UTF-16 little endian with a byte order mark (what the monthly Cloud Storage reports may be). */
export const utf16 = (text: string): Uint8Array => {
  const out = new Uint8Array(2 + text.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = c & 0xff;
    out[3 + i * 2] = c >> 8;
  }
  return out;
};

export const gz = (text: string): Uint8Array => new Uint8Array(gzipSync(Buffer.from(text)));

/** The documented `traffic_source` breakdown. */
export const TRAFFIC_HEADER = ['Date', 'Package name', 'Traffic source', 'Search term', 'UTM source', 'UTM campaign', 'Store listing acquisitions', 'Store listing visitors', 'Store listing conversion rate'];

export const trafficSourceCsv = (a = '2026-11-02', b = '2026-11-03'): string =>
  csv([
    TRAFFIC_HEADER,
    [a, 'com.acme.coffee', 'Google Play search', 'coffee timer', '', '', '5', '40', '0.125'],
    [a, 'com.acme.coffee', 'Google Play search', 'Brew Timer', '', '', '2', '30', '0.0667'],
    [a, 'com.acme.coffee', 'Google Play search', 'Other', '', '', '3', '90', '0.0333'],
    [a, 'com.acme.coffee', 'Third-party referrals', '', 'newsletter', 'launch', '1', '10', '0.1'],
    [a, 'com.acme.coffee', 'Google Play explore', '', '', '', '4', '70', '0.057'],
    [b, 'com.acme.coffee', 'Google Play search', 'coffee timer', '', '', '6', '44', '0.136'],
    [b, 'com.acme.coffee', 'Google Play search', 'espresso app', '', '', '0', '12', '0'],
  ]);

/** A console export for one period, per term, with a country and no date column (UNVERIFIED shape). */
export const periodCsv = (): string =>
  csv([
    ['Search term', 'Country/region', 'Store listing visitors', 'Store listing acquisitions', 'Store listing conversion rate'],
    ['coffee timer', 'US', '1,200', '150', '12.5%'],
    ['coffee timer', 'DE', '300', '20', '6,7 %'],
    ['Brew Timer', 'US', '800', '40', '5%'],
    ['Other', 'US', '5.000', '100', '2%'],
    ['kaffee wecker', 'Deutschland', '100', '2', '2%'],
  ]);

/** The same, renamed and reordered, with a semicolon delimiter and a day column written dd.mm.yyyy. */
export const renamedCsv = (): string =>
  csv(
    [
      ['Installs', 'Query', 'Listing visitors', 'Day'],
      ['7', 'coffee timer', '70', '03.11.2026'],
      ['x', 'bad number', '10', '03.11.2026'],
      ['1', 'brew timer', '9', '2026-13-40'],
    ],
    ';',
  );

/** A store zip: stored entries and deflate entries. No CRC is written (the reader does not check it). */
export function zip(files: { name: string; data: Uint8Array; method?: 0 | 8; flags?: number }[]): Uint8Array {
  const parts: number[][] = [];
  const central: number[][] = [];
  let offset = 0;
  const le = (n: number, bytes: number) => Array.from({ length: bytes }, (_, i) => Math.floor(n / 2 ** (8 * i)) & 0xff);
  for (const f of files) {
    const method = f.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(f.data))) : f.data;
    const name = Array.from(new TextEncoder().encode(f.name));
    const local = [...le(0x04034b50, 4), ...le(20, 2), ...le(f.flags ?? 0, 2), ...le(method, 2), ...le(0, 4), ...le(0, 4), ...le(body.length, 4), ...le(f.data.length, 4), ...le(name.length, 2), ...le(0, 2), ...name, ...Array.from(body)];
    central.push([...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(f.flags ?? 0, 2), ...le(method, 2), ...le(0, 4), ...le(0, 4), ...le(body.length, 4), ...le(f.data.length, 4), ...le(name.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...name]);
    parts.push(local);
    offset += local.length;
  }
  const dir = central.reduce<number[]>((all, c) => all.concat(c), []);
  const end = [...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(files.length, 2), ...le(files.length, 2), ...le(dir.length, 4), ...le(offset, 4), ...le(0, 2)];
  return new Uint8Array([...parts.reduce<number[]>((all, p) => all.concat(p), []), ...dir, ...end]);
}
