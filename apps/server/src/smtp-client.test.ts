import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { cleanText, dataPayload, quotedPrintable } from './services/mail-mime.ts';
import { type SmtpConfig, sendViaSmtp } from './services/smtp-client.ts';
import { type FakeSmtpOptions, startFakeSmtp, testCert } from './smtp-test-server.ts';

// The SMTP client against an in-process server that speaks real SMTP over real sockets (STARTTLS and implicit TLS included).

const cert = testCert();
const needTls = {
  skip: cert ? false : 'openssl is not available to make a test certificate',
} as const;
const NOW = Date.UTC(2026, 10, 19, 10, 0, 0);
const fast = { allowPrivateHosts: true, now: () => NOW, timeoutMs: 2_000, totalTimeoutMs: 8_000 };
const FROM = 'Release Manager <kiln@example.com>';
const config = (port: number, extra: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  secure: 'none',
  from: FROM,
  ...extra,
});
const mail = { to: 'ada@example.com', subject: 'Hello', text: 'Line one\nLine two\n' };

/** Decodes quoted-printable so a test can compare what the server stored with what was sent. */
const unqp = (text: string) =>
  Buffer.from(
    text
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16))),
    'latin1',
  ).toString('utf8');

async function withServer<T>(
  options: FakeSmtpOptions,
  run: (s: Awaited<ReturnType<typeof startFakeSmtp>>) => Promise<T>,
): Promise<T> {
  const server = await startFakeSmtp(options);
  try {
    return await run(server);
  } finally {
    await server.close();
  }
}

test('plain SMTP: the envelope, the headers and the body arrive, with CRLF line ends', async () => {
  await withServer({}, async (server) => {
    const result = await sendViaSmtp(config(server.port), mail, fast);
    assert.deepEqual(result, { ok: true });
    const got = server.messages[0];
    assert.ok(got);
    assert.equal(got.from, 'kiln@example.com');
    assert.deepEqual(got.to, ['ada@example.com']);
    assert.match(got.data, /^From: Release Manager <kiln@example\.com>\r\n/);
    assert.match(got.data, /\r\nTo: ada@example\.com\r\n/);
    assert.match(got.data, /\r\nSubject: Hello\r\n/);
    assert.match(got.data, /\r\nMIME-Version: 1\.0\r\n/);
    assert.match(got.data, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
    assert.ok(got.data.endsWith('Line one\r\nLine two\r\n'));
    assert.equal(got.tls, false);
    assert.ok(!/(^|[^\r])\n/.test(got.data), 'every line break is CRLF');
  });
});

test('text and html become multipart/alternative; non-ASCII text survives quoted-printable', async () => {
  await withServer({}, async (server) => {
    const text = 'Prix = 5 € — café\nça marche ';
    const html = '<p>Prix = 5 € — café</p>';
    assert.deepEqual(
      await sendViaSmtp(config(server.port), { ...mail, subject: 'Café — prêt', text, html }, fast),
      { ok: true },
    );
    const data = server.messages[0]?.data ?? '';
    assert.match(data, /Content-Type: multipart\/alternative; boundary="=_kiln_[0-9a-f]+"/);
    assert.match(data, /Subject: =\?UTF-8\?B\?/);
    const decoded = unqp(data);
    assert.ok(
      decoded.includes(text.replace(/\n/g, '\r\n')),
      'the text part decodes to what was sent',
    );
    assert.ok(decoded.includes('<p>Prix = 5 € — café</p>'), 'and so does the html part');
    assert.equal((data.match(/--=_kiln_[0-9a-f]+--/g) ?? []).length, 1);
    for (const line of data.split('\r\n')) assert.ok(line.length <= 998);
    assert.ok(/^[\x20-\x7e\r\n]*$/.test(data), 'the wire carries 7-bit text only');
  });
});

test('a line that starts with a dot is dot-stuffed on the wire and arrives intact', async () => {
  await withServer({}, async (server) => {
    const text = 'first\n.hidden\n.\n..two\nlast';
    assert.deepEqual(await sendViaSmtp(config(server.port), { ...mail, text }, fast), { ok: true });
    const got = server.messages[0];
    assert.ok(got?.raw.includes('\r\n..hidden\r\n'), 'doubled on the wire');
    assert.ok(got?.raw.includes('\r\n...two\r\n'));
    assert.ok(got?.data.includes('\r\n.hidden\r\n.\r\n..two\r\n'), 'unstuffed by the receiver');
  });
  assert.equal(dataPayload('a\r\n.b\r\n'), 'a\r\n..b\r\n.\r\n');
  assert.equal(quotedPrintable('x=y '), 'x=3Dy=20');
});

test('header injection: a line break in the subject or an address never makes a new header or a new recipient', async () => {
  await withServer({}, async (server) => {
    const sent = await sendViaSmtp(
      config(server.port),
      { ...mail, subject: 'Hi\r\nBcc: evil@example.com\r\n\r\nGotcha' },
      fast,
    );
    assert.deepEqual(sent, { ok: true });
    const data = server.messages[0]?.data ?? '';
    const head = data.slice(0, data.indexOf('\r\n\r\n'));
    assert.ok(!/^Bcc:/im.test(head), head);
    assert.match(head, /^Subject: Hi Bcc: evil@example\.com Gotcha$/m);
    assert.deepEqual(server.messages[0]?.to, ['ada@example.com']);

    for (const bad of [
      'a@b.com\r\nRCPT TO:<evil@example.com>',
      'a@b.com>\r\nX: y',
      'a b@example.com',
      'Ada <a@b.com>',
      '"a"@b.com',
      'a@b.com, c@d.com',
      'a@@b.com',
      '@b.com',
      'a@',
    ]) {
      const before = server.connections;
      assert.deepEqual(
        await sendViaSmtp(config(server.port), { ...mail, to: bad }, fast),
        { ok: false, code: 'smtp_rejected', hint: 'invalid_address' },
        JSON.stringify(bad),
      );
      assert.equal(server.connections, before, 'refused before any connection');
    }
    assert.deepEqual(
      await sendViaSmtp(
        config(server.port, { from: 'x@example.com\r\nBcc: evil@example.com' }),
        mail,
        fast,
      ),
      { ok: false, code: 'smtp_rejected', hint: 'invalid_address' },
    );
  });
  assert.equal(cleanText('a\r\nb\tc\u0000d'), 'a b c d');
});

test('recipients: several, de-duplicated, at most 20', async () => {
  await withServer({}, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(
        config(server.port),
        { ...mail, to: ['a@example.com', 'b@example.com', 'a@example.com'] },
        fast,
      ),
      { ok: true },
    );
    assert.deepEqual(server.messages[0]?.to, ['a@example.com', 'b@example.com']);
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    assert.deepEqual(await sendViaSmtp(config(server.port), { ...mail, to: many }, fast), {
      ok: false,
      code: 'smtp_rejected',
      hint: 'invalid_address',
    });
  });
});

test('AUTH PLAIN and AUTH LOGIN; a wrong password is smtp_auth_failed; the password is never in the data', async () => {
  const auth = { user: 'kiln', password: 's3cret pass' };
  await withServer({ auth }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 's3cret pass' }), mail, fast),
      { ok: true },
    );
    assert.equal(server.messages[0]?.user, 'kiln');
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 'nope' }), mail, fast),
      { ok: false, code: 'smtp_auth_failed' },
    );
    assert.ok(!server.messages[0]?.data.includes('s3cret'));
  });
  await withServer({ auth: { ...auth, mechanisms: ['LOGIN'] } }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 's3cret pass' }), mail, fast),
      { ok: true },
    );
    assert.deepEqual(
      await sendViaSmtp(
        config(server.port, { user: 'other', password: 's3cret pass' }),
        mail,
        fast,
      ),
      { ok: false, code: 'smtp_auth_failed' },
    );
  });
  await withServer({ auth: { ...auth, mechanisms: ['PLAIN'] } }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 's3cret pass' }), mail, fast),
      { ok: true },
    );
  });
  // A login that the server does not offer (no AUTH line at all).
  await withServer({}, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 'x' }), mail, fast),
      { ok: false, code: 'smtp_auth_failed', hint: 'no_auth_mechanism' },
    );
  });
});

test(
  'STARTTLS: the connection is upgraded, the certificate is checked, and a password only goes after the upgrade',
  needTls,
  async () => {
    const auth = { user: 'kiln', password: 'pw' };
    await withServer(
      { cert: cert ?? undefined, starttls: true, auth, authOnlyAfterTls: true },
      async (server) => {
        const ok = await sendViaSmtp(
          config(server.port, { secure: 'starttls', user: 'kiln', password: 'pw' }),
          mail,
          { ...fast, tls: { ca: cert?.cert } },
        );
        assert.deepEqual(ok, { ok: true });
        assert.equal(server.messages[0]?.tls, true);
        assert.equal(server.messages[0]?.user, 'kiln');
        // EHLO again after the upgrade, and AUTH only after STARTTLS.
        const ehlos = server.commands.filter((c) => /^EHLO/i.test(c)).length;
        assert.equal(ehlos, 2);
        assert.ok(server.commands.indexOf('STARTTLS') < server.commands.indexOf('AUTH ***'));
      },
    );
  },
);

test(
  'STARTTLS with a certificate nobody trusts is smtp_tls_failed, and nothing is sent',
  needTls,
  async () => {
    await withServer({ cert: cert ?? undefined, starttls: true }, async (server) => {
      const result = await sendViaSmtp(config(server.port, { secure: 'starttls' }), mail, fast);
      assert.deepEqual(result, {
        ok: false,
        code: 'smtp_tls_failed',
        hint: 'certificate_rejected',
      });
      assert.equal(server.messages.length, 0);
      assert.ok(!server.commands.some((c) => /^MAIL/i.test(c)));
    });
  },
);

test('STARTTLS asked for but not offered is smtp_tls_failed: there is no quiet downgrade to plain text', async () => {
  await withServer({}, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(
        config(server.port, { secure: 'starttls', user: 'kiln', password: 'pw' }),
        mail,
        fast,
      ),
      { ok: false, code: 'smtp_tls_failed', hint: 'starttls_not_offered' },
    );
    assert.ok(!server.commands.some((c) => /^(AUTH|MAIL)/i.test(c)));
  });
});

test(
  'implicit TLS (port 465 style) works with a trusted certificate and fails closed without trust',
  needTls,
  async () => {
    await withServer({ cert: cert ?? undefined, implicitTls: true }, async (server) => {
      assert.deepEqual(
        await sendViaSmtp(config(server.port, { secure: 'tls' }), mail, {
          ...fast,
          tls: { ca: cert?.cert },
        }),
        { ok: true },
      );
      assert.equal(server.messages[0]?.tls, true);
      assert.deepEqual(await sendViaSmtp(config(server.port, { secure: 'tls' }), mail, fast), {
        ok: false,
        code: 'smtp_tls_failed',
        hint: 'certificate_rejected',
      });
    });
    // TLS asked for, a plain server answering: not a connection that can be trusted.
    await withServer({}, async (server) => {
      const result = await sendViaSmtp(config(server.port, { secure: 'tls' }), mail, fast);
      assert.equal(result.ok, false);
      assert.ok(
        !result.ok &&
          (result.code === 'smtp_tls_failed' ||
            result.code === 'smtp_timeout' ||
            result.code === 'smtp_connection_failed'),
      );
    });
  },
);

test('a login over plain text to another machine is refused before connecting; to this machine it is allowed', async () => {
  const away = async () => [{ address: '10.1.2.3', family: 4 }];
  const result = await sendViaSmtp(
    {
      host: 'mail.internal.example',
      port: 25,
      secure: 'none',
      from: FROM,
      user: 'kiln',
      password: 'pw',
    },
    mail,
    { ...fast, resolve: away },
  );
  assert.deepEqual(result, { ok: false, code: 'smtp_tls_failed', hint: 'login_needs_tls' });
  await withServer({ auth: { user: 'kiln', password: 'pw' } }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port, { user: 'kiln', password: 'pw' }), mail, fast),
      { ok: true },
    );
  });
});

test('a refused recipient or a refused message is smtp_rejected', async () => {
  await withServer({ rejectRcpt: ['nobody@example.com'] }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port), { ...mail, to: 'nobody@example.com' }, fast),
      { ok: false, code: 'smtp_rejected' },
    );
    assert.equal(server.messages.length, 0);
  });
  await withServer({ dataReply: '554 5.7.1 Spam' }, async (server) => {
    assert.deepEqual(await sendViaSmtp(config(server.port), mail, fast), {
      ok: false,
      code: 'smtp_rejected',
    });
  });
  await withServer({ auth: { user: 'a', password: 'b' } }, async (server) => {
    // The server wants a login and the client has none: MAIL is refused (530).
    assert.deepEqual(await sendViaSmtp(config(server.port), mail, fast), {
      ok: false,
      code: 'smtp_rejected',
    });
  });
});

test('size: a body over the cap, and a message over the server SIZE, are refused before sending', async () => {
  await withServer({ size: 2000 }, async (server) => {
    assert.deepEqual(
      await sendViaSmtp(config(server.port), { ...mail, text: 'x'.repeat(5000) }, fast),
      { ok: false, code: 'smtp_rejected', hint: 'message_too_large' },
    );
    assert.ok(!server.commands.some((c) => /^DATA/i.test(c)));
    assert.deepEqual(
      await sendViaSmtp(config(server.port), { ...mail, text: 'x'.repeat(250_000) }, fast),
      { ok: false, code: 'smtp_rejected', hint: 'message_too_large' },
    );
  });
});

test('timeouts: a server that never speaks is smtp_timeout; a closed port is smtp_connection_failed', async () => {
  await withServer({ silent: true }, async (server) => {
    const started = Date.now();
    assert.deepEqual(
      await sendViaSmtp(config(server.port), mail, {
        ...fast,
        timeoutMs: 150,
        totalTimeoutMs: 2_000,
      }),
      { ok: false, code: 'smtp_timeout' },
    );
    assert.ok(Date.now() - started < 1_500);
  });
  const closed = await new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
  assert.deepEqual(await sendViaSmtp(config(closed), mail, fast), {
    ok: false,
    code: 'smtp_connection_failed',
  });
});

test('a hostile server: a greeting that is not 220, and an endless line, are connection failures, not memory', async () => {
  await withServer({ greeting: '554 no service' }, async (server) => {
    assert.deepEqual(await sendViaSmtp(config(server.port), mail, fast), {
      ok: false,
      code: 'smtp_connection_failed',
    });
  });
  await withServer({ flood: 200_000 }, async (server) => {
    assert.deepEqual(await sendViaSmtp(config(server.port), mail, fast), {
      ok: false,
      code: 'smtp_connection_failed',
    });
  });
});

test('the address policy: private and loopback hosts are refused unless allowed; link-local and metadata never', async () => {
  const resolveTo = (address: string) => async () => [
    { address, family: address.includes(':') ? 6 : 4 },
  ];
  const base = { host: 'mail.example.com', port: 25, secure: 'none' as const, from: FROM };
  const strict = { now: () => NOW, timeoutMs: 300 };
  assert.deepEqual(await sendViaSmtp({ ...base, host: '127.0.0.1' }, mail, strict), {
    ok: false,
    code: 'smtp_connection_failed',
    hint: 'private_address_blocked',
  });
  assert.deepEqual(await sendViaSmtp({ ...base, host: '10.0.0.5' }, mail, strict), {
    ok: false,
    code: 'smtp_connection_failed',
    hint: 'private_address_blocked',
  });
  assert.deepEqual(
    await sendViaSmtp(base, mail, { ...strict, resolve: resolveTo('192.168.1.10') }),
    { ok: false, code: 'smtp_connection_failed', hint: 'private_address_blocked' },
  );
  assert.deepEqual(await sendViaSmtp(base, mail, { ...strict, resolve: resolveTo('::1') }), {
    ok: false,
    code: 'smtp_connection_failed',
    hint: 'private_address_blocked',
  });
  // Even with private hosts allowed: the metadata address of a cloud, and a name that points to it.
  assert.deepEqual(
    await sendViaSmtp({ ...base, host: '169.254.169.254' }, mail, {
      ...strict,
      allowPrivateHosts: true,
    }),
    { ok: false, code: 'smtp_connection_failed', hint: 'host_not_allowed' },
  );
  assert.deepEqual(
    await sendViaSmtp(base, mail, {
      ...strict,
      allowPrivateHosts: true,
      resolve: resolveTo('169.254.169.254'),
    }),
    { ok: false, code: 'smtp_connection_failed', hint: 'host_not_allowed' },
  );
  // A name with ONE bad answer among good ones is refused.
  const mixed = async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ];
  assert.deepEqual(await sendViaSmtp(base, mail, { ...strict, resolve: mixed }), {
    ok: false,
    code: 'smtp_connection_failed',
    hint: 'private_address_blocked',
  });
  // A host name that does not resolve, and a host that is not a host.
  assert.deepEqual(
    await sendViaSmtp(base, mail, {
      ...strict,
      resolve: async () => {
        throw new Error('nx');
      },
    }),
    { ok: false, code: 'smtp_connection_failed', hint: 'host_not_found' },
  );
  assert.deepEqual(await sendViaSmtp({ ...base, host: 'a b' }, mail, strict), {
    ok: false,
    code: 'smtp_connection_failed',
    hint: 'host_not_allowed',
  });
});

test('the socket goes to the address that was checked, not to whatever the name says later', async () => {
  await withServer({}, async (server) => {
    let calls = 0;
    // First answer is the fake server on loopback; a second lookup (a rebind) would point elsewhere. Only one lookup is made.
    const resolve = async () => {
      calls++;
      return calls === 1
        ? [{ address: '127.0.0.1', family: 4 }]
        : [{ address: '203.0.113.9', family: 4 }];
    };
    assert.deepEqual(
      await sendViaSmtp(
        { host: 'mail.example.test', port: server.port, secure: 'none', from: FROM },
        mail,
        { ...fast, resolve },
      ),
      { ok: true },
    );
    assert.equal(calls, 1);
  });
});
