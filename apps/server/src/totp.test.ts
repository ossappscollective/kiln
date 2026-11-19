import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base32Decode,
  base32Encode,
  checkTotp,
  hotp,
  normalizeTotpCode,
  otpauthUri,
  totpAt,
  totpStep,
} from './services/totp.ts';

// RFC 4226 (HOTP) and RFC 6238 (TOTP, SHA-1) test vectors. The RFC 6238 secret is the ASCII text 12345678901234567890; the RFC lists
// 8 digit codes, of which a 6 digit code is the last six digits.

const SECRET = Buffer.from('12345678901234567890');

test('RFC 4226 appendix D: the HOTP values for counters 0 to 9', () => {
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];
  expected.forEach((code, counter) =>
    assert.equal(hotp(SECRET, counter), code, `counter ${counter}`),
  );
});

test('RFC 6238 appendix B (SHA-1): the codes at the listed times', () => {
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, eight] of vectors)
    assert.equal(totpAt(SECRET, seconds * 1000), eight.slice(2), `T=${seconds}`);
});

test('base32 round trips and ignores case, spaces, dashes and padding; other characters are refused', () => {
  assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  assert.equal(base32Decode('mzxw 6ytb-oi====')?.toString(), 'foobar');
  assert.equal(base32Decode('MZXW1'), undefined, '1 is not base32');
  for (let n = 0; n < 40; n++) {
    const bytes = Buffer.alloc(n, n + 7);
    assert.deepEqual(base32Decode(base32Encode(bytes)), bytes);
  }
});

test('a code is accepted one step either way, and not two', () => {
  const t = 1_800_000_000_000;
  const at = (delta: number) => totpAt(SECRET, t + delta * 30_000);
  assert.deepEqual(checkTotp(SECRET, at(0), t, null), { ok: true, step: totpStep(t) });
  assert.deepEqual(checkTotp(SECRET, at(-1), t, null), { ok: true, step: totpStep(t) - 1 });
  assert.deepEqual(checkTotp(SECRET, at(1), t, null), { ok: true, step: totpStep(t) + 1 });
  assert.deepEqual(checkTotp(SECRET, at(-2), t, null), { ok: false, reason: 'invalid' });
  assert.deepEqual(checkTotp(SECRET, at(2), t, null), { ok: false, reason: 'invalid' });
});

test('replay: a code whose step is not after the last accepted one is refused', () => {
  const t = 1_800_000_000_000;
  const code = totpAt(SECRET, t);
  const first = checkTotp(SECRET, code, t, null);
  assert.ok(first.ok);
  const step = first.ok ? first.step : 0;
  assert.deepEqual(checkTotp(SECRET, code, t, step), { ok: false, reason: 'replay' });
  assert.deepEqual(checkTotp(SECRET, code, t + 20_000, step), { ok: false, reason: 'replay' });
  // The older neighbour is a replay too, the next step is fine.
  assert.deepEqual(checkTotp(SECRET, totpAt(SECRET, t - 30_000), t, step), {
    ok: false,
    reason: 'replay',
  });
  assert.deepEqual(checkTotp(SECRET, totpAt(SECRET, t + 30_000), t, step), {
    ok: true,
    step: step + 1,
  });
});

test('typing: spaces and a dash are fine; anything that is not six digits is malformed', () => {
  assert.equal(normalizeTotpCode('287 082'), '287082');
  assert.equal(normalizeTotpCode(' 287-082 '), '287082');
  for (const bad of ['', '12345', '1234567', 'abcdef', '28708a', '287082\n1'])
    assert.equal(normalizeTotpCode(bad), undefined, bad);
  assert.deepEqual(checkTotp(SECRET, '12345', 59_000, null), { ok: false, reason: 'malformed' });
});

test('the otpauth link is the Key URI Format an authenticator app reads', () => {
  const uri = otpauthUri({
    issuer: 'Mobile Release Manager',
    account: 'ada@example.com',
    secret: SECRET,
  });
  assert.equal(
    uri,
    'otpauth://totp/Mobile%20Release%20Manager:ada%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Mobile%20Release%20Manager&algorithm=SHA1&digits=6&period=30',
  );
  const hostile = otpauthUri({ issuer: 'A:B\r\nC', account: 'x:y&z=1', secret: SECRET });
  assert.ok(!/[\r\n]/.test(hostile));
  assert.equal(new URL(hostile).searchParams.get('issuer'), 'A B C');
  assert.equal(
    new URL(hostile).searchParams.get('z'),
    null,
    'a & in the account cannot add a parameter',
  );
});
