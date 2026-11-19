import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';

/**
 * An SMTP server for tests, in this process, that speaks real SMTP over real sockets: greeting, EHLO with capabilities, STARTTLS (a real
 * TLS upgrade), implicit TLS, AUTH PLAIN and LOGIN, MAIL FROM, RCPT TO, DATA with dot-unstuffing, RSET, QUIT. Not a test file, so the
 * runner skips it. It can also misbehave on purpose (no greeting, a refused recipient, a flood with no line end).
 */

export type TestCert = { key: string; cert: string };

let cached: TestCert | null | undefined;

/** A self-signed certificate for localhost and 127.0.0.1, made with openssl (null when openssl is not there, so a test can skip). */
export function testCert(): TestCert | null {
  if (cached !== undefined) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'mrm-smtp-'));
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { stdio: 'ignore' },
    );
    cached = { key: readFileSync(join(dir, 'k.pem'), 'utf8'), cert: readFileSync(join(dir, 'c.pem'), 'utf8') };
  } catch {
    cached = null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached;
}

export type Received = { from: string; to: string[]; data: string; raw: string; tls: boolean; user: string | undefined };

export type FakeSmtpOptions = {
  cert?: TestCert;
  /** TLS from the first byte. */
  implicitTls?: boolean;
  /** Offer STARTTLS (needs `cert`). */
  starttls?: boolean;
  /** Require this login; mechanisms offered (default both). */
  auth?: { user: string; password: string; mechanisms?: ('PLAIN' | 'LOGIN')[] };
  /** Offer AUTH only after TLS (as real servers do). */
  authOnlyAfterTls?: boolean;
  /** Recipients that get `550`. */
  rejectRcpt?: string[];
  /** `SIZE n` in EHLO. */
  size?: number;
  /** The reply to DATA's end (default `250 queued`). */
  dataReply?: string;
  /** Say nothing at all after the connection opens. */
  silent?: boolean;
  /** Greet with this instead of `220 fake ESMTP`. */
  greeting?: string;
  /** Send this many bytes with no line end instead of a greeting. */
  flood?: number;
};

export type FakeSmtp = {
  port: number;
  host: string;
  messages: Received[];
  /** Every command line the client sent (AUTH payloads are replaced by `AUTH ***`). */
  commands: string[];
  connections: number;
  close(): Promise<void>;
};

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: Received[] = [];
  const commands: string[] = [];
  const state = { connections: 0 };
  const sockets = new Set<net.Socket>();
  const secureContext = options.cert ? tls.createSecureContext({ key: options.cert.key, cert: options.cert.cert }) : undefined;

  const serve = (socket: net.Socket, secure: boolean, greet: boolean) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer = '';
    let mode: 'command' | 'data' | 'auth-plain' | 'auth-user' | 'auth-pass' = 'command';
    let from = '';
    let to: string[] = [];
    let body = '';
    let user: string | undefined;
    let loginUser = '';
    const write = (line: string) => socket.write(`${line}\r\n`);
    const authOffered = () => options.auth && !(options.authOnlyAfterTls && !secure);
    const finishAuth = (u: string, p: string) => {
      if (options.auth && u === options.auth.user && p === options.auth.password) {
        user = u;
        write('235 2.7.0 Authentication successful');
      } else write('535 5.7.8 Authentication credentials invalid');
      mode = 'command';
    };
    if (greet) {
      if (options.flood) socket.write('x'.repeat(options.flood));
      else if (!options.silent) write(options.greeting ?? '220 fake ESMTP');
    }
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      for (;;) {
        if (mode === 'data') {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buffer.slice(0, end + 2);
          buffer = buffer.slice(end + 5);
          body = raw;
          messages.push({ from, to, data: raw.replace(/^\.\./gm, '.'), raw, tls: secure, user });
          write(options.dataReply ?? '250 2.0.0 queued');
          mode = 'command';
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol < 0) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        if (mode === 'auth-plain') {
          commands.push('AUTH ***');
          const [, u = '', p = ''] = Buffer.from(line, 'base64').toString().split('\0');
          finishAuth(u, p);
          continue;
        }
        if (mode === 'auth-user') {
          commands.push('AUTH ***');
          loginUser = Buffer.from(line, 'base64').toString();
          mode = 'auth-pass';
          write('334 UGFzc3dvcmQ6');
          continue;
        }
        if (mode === 'auth-pass') {
          commands.push('AUTH ***');
          finishAuth(loginUser, Buffer.from(line, 'base64').toString());
          continue;
        }
        const upper = line.toUpperCase();
        commands.push(/^AUTH /i.test(line) ? 'AUTH ***' : line);
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          const caps = ['fake', '8BITMIME'];
          if (options.size) caps.push(`SIZE ${options.size}`);
          if (options.starttls && !secure) caps.push('STARTTLS');
          if (authOffered()) caps.push(`AUTH ${(options.auth?.mechanisms ?? ['PLAIN', 'LOGIN']).join(' ')}`);
          caps.forEach((c, i) => write(`250${i === caps.length - 1 ? ' ' : '-'}${c}`));
        } else if (upper === 'STARTTLS') {
          if (!secureContext) {
            write('454 TLS not available');
            continue;
          }
          write('220 Ready to start TLS');
          socket.removeAllListeners('data');
          const wrapped = new tls.TLSSocket(socket, { isServer: true, secureContext });
          serve(wrapped, true, false);
          return;
        } else if (upper.startsWith('AUTH PLAIN')) {
          const rest = line.slice(10).trim();
          if (rest) {
            commands[commands.length - 1] = 'AUTH ***';
            const [, u = '', p = ''] = Buffer.from(rest, 'base64').toString().split('\0');
            finishAuth(u, p);
          } else {
            mode = 'auth-plain';
            write('334 ');
          }
        } else if (upper === 'AUTH LOGIN') {
          mode = 'auth-user';
          write('334 VXNlcm5hbWU6');
        } else if (upper.startsWith('MAIL FROM:')) {
          if (options.auth && !user) {
            write('530 5.7.0 Authentication required');
            continue;
          }
          from = line.slice(10).replace(/[<>]/g, '').trim();
          to = [];
          write('250 2.1.0 OK');
        } else if (upper.startsWith('RCPT TO:')) {
          const rcpt = line.slice(8).replace(/[<>]/g, '').trim();
          if (options.rejectRcpt?.includes(rcpt)) write('550 5.1.1 No such user');
          else {
            to.push(rcpt);
            write('250 2.1.5 OK');
          }
        } else if (upper === 'DATA') {
          mode = 'data';
          body = '';
          write('354 End data with <CR><LF>.<CR><LF>');
        } else if (upper === 'RSET') write('250 OK');
        else if (upper === 'QUIT') {
          write('221 Bye');
          socket.end();
          return;
        } else write('500 5.5.2 Command not recognized');
        void body;
      }
    });
  };

  const server = options.implicitTls && options.cert
    ? tls.createServer({ key: options.cert.key, cert: options.cert.cert }, (s) => {
        state.connections++;
        serve(s, true, true);
      })
    : net.createServer((s) => {
        state.connections++;
        serve(s, false, true);
      });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    host: '127.0.0.1',
    messages,
    commands,
    get connections() {
      return state.connections;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
