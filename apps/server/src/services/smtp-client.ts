import { isIP } from 'node:net';
import net from 'node:net';
import tls from 'node:tls';
import { type MailErrorCode, type MailHint, type MailInput, type MailResult } from './mailer.ts';
import { buildMessage, dataPayload, parseMailbox } from './mail-mime.ts';
import { type Resolver, classifyAddress, systemResolver } from './webhook-transport.ts';

/**
 * A small SMTP client on node:net and node:tls (no dependency). It speaks RFC 5321 submission: plain, STARTTLS (RFC 3207) or
 * implicit TLS, AUTH PLAIN or LOGIN, one message per connection. What it will not do, on purpose:
 *
 * - connect anywhere but the ONE address it checked (a host that resolves to a private or loopback address is refused unless the
 *   operator allowed private hosts, a link-local or metadata address never; the socket goes to the checked address, so a DNS
 *   answer that changes between the check and the connection cannot redirect it);
 * - send a password on a connection that is not encrypted (except to a loopback address, for a local relay);
 * - carry on without TLS when STARTTLS was asked for (no downgrade), or accept a certificate that does not verify;
 * - wait forever (a time limit per step and one for the whole delivery), read an unbounded reply, or send a message over 1 MiB;
 * - report anything a server said: the result is a code from a fixed list. Nothing is logged here.
 */

export type SmtpSecure = 'none' | 'starttls' | 'tls';
export const smtpSecureModes: readonly SmtpSecure[] = ['none', 'starttls', 'tls'];

export type SmtpConfig = {
  host: string;
  port: number;
  secure: SmtpSecure;
  user?: string;
  password?: string;
  /** `ada@example.com` or `Name <ada@example.com>`. */
  from: string;
};

export const defaultPort = (secure: SmtpSecure): number => (secure === 'tls' ? 465 : secure === 'none' ? 25 : 587);

export type SmtpOptions = {
  /** Private and loopback addresses may be used (MRM_SMTP_ALLOW_PRIVATE_HOSTS). */
  allowPrivateHosts?: boolean;
  resolve?: Resolver;
  now?: () => number;
  /** Per step (connect, one reply). Default 15 s. */
  timeoutMs?: number;
  /** For the whole delivery. Default 60 s. */
  totalTimeoutMs?: number;
  /** Tests: extra TLS options such as `ca`. Certificate verification is never switched off by the app. */
  tls?: tls.ConnectionOptions;
  /** The name sent in EHLO. Default `mrm.local`. */
  helo?: string;
};

export class SmtpFailure extends Error {
  readonly code: MailErrorCode;
  readonly hint: MailHint | undefined;
  constructor(code: MailErrorCode, hint?: MailHint) {
    super(code);
    this.code = code;
    this.hint = hint;
  }
}

// ---------------------------------------------------------------------------------------------
// Where we may connect

export type HostCheck =
  | { ok: true; address: string; family: 4 | 6; loopback: boolean }
  | { ok: false; hint: 'private_address_blocked' | 'host_not_allowed' | 'host_not_found' };

const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
export const validHost = (host: string): boolean => (isIP(host) !== 0 ? true : HOST_NAME.test(host));

const isLoopback = (address: string) => /^127\./.test(address) || address === '::1' || /^::ffff:127\./i.test(address);

/** Resolves the host and applies the address policy. Never touches the mail server itself. */
export async function checkMailHost(host: string, options: Pick<SmtpOptions, 'allowPrivateHosts' | 'resolve'> = {}): Promise<HostCheck> {
  if (!validHost(host)) return { ok: false, hint: 'host_not_allowed' };
  let answers: { address: string; family: number }[];
  if (isIP(host) !== 0) answers = [{ address: host, family: isIP(host) }];
  else {
    try {
      answers = await (options.resolve ?? systemResolver)(host);
    } catch {
      return { ok: false, hint: 'host_not_found' };
    }
  }
  const first = answers[0];
  if (!first) return { ok: false, hint: 'host_not_found' };
  let blockedPrivate = false;
  for (const { address } of answers) {
    const cls = classifyAddress(address);
    if (cls === 'blocked') return { ok: false, hint: 'host_not_allowed' };
    if (cls === 'private' && !options.allowPrivateHosts) blockedPrivate = true;
  }
  if (blockedPrivate) return { ok: false, hint: 'private_address_blocked' };
  return { ok: true, address: first.address, family: first.family === 6 ? 6 : 4, loopback: isLoopback(first.address) };
}

// ---------------------------------------------------------------------------------------------
// The wire

type Reply = { code: number; lines: string[] };

const MAX_REPLY_BYTES = 16 * 1024;
const MAX_REPLY_LINES = 100;

function mapSocketError(error: unknown, secure: boolean): SmtpFailure {
  const code = String((error as { code?: unknown } | null)?.code ?? '');
  if (code === 'ETIMEDOUT') return new SmtpFailure('smtp_timeout');
  if (/^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH|ERR_OSSL)/.test(code) || code === 'EPROTO') {
    return new SmtpFailure('smtp_tls_failed', 'certificate_rejected');
  }
  return new SmtpFailure(secure && code === 'ECONNRESET' ? 'smtp_tls_failed' : 'smtp_connection_failed');
}

class Wire {
  readonly socket: net.Socket;
  private buffer = '';
  private lines: string[] = [];
  private queue: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: SmtpFailure) => void; timer: NodeJS.Timeout } | undefined;
  private failure: SmtpFailure | undefined;
  private readonly secure: boolean;
  private readonly onData = (chunk: Buffer) => this.take(chunk.toString('latin1'));

  constructor(socket: net.Socket, secure: boolean) {
    this.socket = socket;
    this.secure = secure;
    socket.on('data', this.onData);
    socket.on('error', (e) => this.fail(mapSocketError(e, secure)));
    socket.on('close', () => this.fail(new SmtpFailure('smtp_connection_failed')));
  }

  private take(text: string) {
    this.buffer += text;
    if (this.buffer.length > MAX_REPLY_BYTES) return this.fail(new SmtpFailure('smtp_connection_failed'));
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) break;
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      this.lines.push(line);
      if (this.lines.length > MAX_REPLY_LINES) return this.fail(new SmtpFailure('smtp_connection_failed'));
      const m = /^(\d{3})([ -]|$)/.exec(line);
      if (!m) return this.fail(new SmtpFailure('smtp_connection_failed'));
      if (m[2] !== '-') {
        const reply = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        this.deliver(reply);
      }
    }
  }

  private deliver(reply: Reply) {
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      clearTimeout(w.timer);
      w.resolve(reply);
    } else this.queue.push(reply);
  }

  /** After this, every wait fails with `failure` (the first failure wins). */
  fail(failure: SmtpFailure) {
    if (this.failure) return;
    this.failure = failure;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      clearTimeout(w.timer);
      w.reject(failure);
    }
    this.socket.destroy();
  }

  read(timeoutMs: number): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new SmtpFailure('smtp_timeout')), timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }

  write(data: string) {
    if (this.failure) throw this.failure;
    this.socket.write(data, 'latin1');
  }

  /** Hands the raw socket to TLS. Anything the server sent before TLS began is an attack, not a reply. */
  detach(): net.Socket {
    if (this.buffer.length > 0 || this.lines.length > 0 || this.queue.length > 0) throw new SmtpFailure('smtp_tls_failed');
    this.socket.removeListener('data', this.onData);
    this.socket.removeAllListeners('close');
    this.socket.removeAllListeners('error');
    this.socket.on('error', () => undefined);
    return this.socket;
  }

  get inSecure() {
    return this.secure;
  }
}

function connect(address: string, family: 4 | 6, port: number, implicitTls: boolean, servername: string | undefined, timeoutMs: number, tlsOptions: tls.ConnectionOptions | undefined): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket;
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      socket?.destroy();
      reject(new SmtpFailure('smtp_timeout'));
    }, timeoutMs);
    const onError = (e: unknown) => done(() => reject(mapSocketError(e, implicitTls)));
    if (implicitTls) {
      socket = tls.connect({ host: address, port, ...(servername ? { servername } : {}), minVersion: 'TLSv1.2', ...tlsOptions });
      socket.once('secureConnect', () => done(() => resolve(socket)));
    } else {
      socket = net.connect({ host: address, family, port });
      socket.once('connect', () => done(() => resolve(socket)));
    }
    socket.once('error', onError);
  });
}

function upgrade(socket: net.Socket, host: string, timeoutMs: number, tlsOptions: tls.ConnectionOptions | undefined): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, ...(isIP(host) === 0 ? { servername: host } : { host }), minVersion: 'TLSv1.2', ...tlsOptions });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SmtpFailure('smtp_timeout'));
    }, timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(secure);
    });
    secure.once('error', (e) => {
      clearTimeout(timer);
      const mapped = mapSocketError(e, true);
      reject(mapped.code === 'smtp_connection_failed' ? new SmtpFailure('smtp_tls_failed') : mapped);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// One delivery

const capabilities = (lines: string[]) => lines.slice(1).map((l) => l.slice(4).trim().toUpperCase());

/** Sends a built message. Resolves to a result, never throws for a mail problem. */
export async function deliver(
  config: SmtpConfig,
  target: { address: string; family: 4 | 6; loopback: boolean },
  message: { envelopeFrom: string; envelopeTo: string[]; data: string },
  options: SmtpOptions = {},
): Promise<MailResult> {
  const step = options.timeoutMs ?? 15_000;
  const total = options.totalTimeoutMs ?? 60_000;
  const helo = (options.helo ?? 'mrm.local').replace(/[^A-Za-z0-9.-]/g, '') || 'mrm.local';
  let wire: Wire | undefined;
  let giveUp: NodeJS.Timeout | undefined;
  let overall: SmtpFailure | undefined;
  const servername = isIP(config.host) === 0 ? config.host : undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      giveUp = setTimeout(() => {
        overall = new SmtpFailure('smtp_timeout');
        wire?.fail(overall);
        reject(overall);
      }, total);
    });
    const run = async (): Promise<MailResult> => {
      // Before anything is sent or even connected: a password never goes over a plain connection to another machine.
      if (config.user && config.secure === 'none' && !target.loopback) throw new SmtpFailure('smtp_tls_failed', 'login_needs_tls');
      const socket = await connect(target.address, target.family, config.port, config.secure === 'tls', servername, step, options.tls);
      wire = new Wire(socket, config.secure === 'tls');
      const greeting = await wire.read(step);
      if (greeting.code !== 220) throw new SmtpFailure('smtp_connection_failed');

      const ehlo = async (): Promise<string[]> => {
        const w = wire as Wire;
        w.write(`EHLO ${helo}\r\n`);
        let reply = await w.read(step);
        if (reply.code >= 500) {
          // An old server that does not know EHLO.
          w.write(`HELO ${helo}\r\n`);
          reply = await w.read(step);
          if (reply.code !== 250) throw new SmtpFailure('smtp_connection_failed');
          return [];
        }
        if (reply.code !== 250) throw new SmtpFailure('smtp_connection_failed');
        return capabilities(reply.lines);
      };
      let caps = await ehlo();

      if (config.secure === 'starttls') {
        if (!caps.includes('STARTTLS')) throw new SmtpFailure('smtp_tls_failed', 'starttls_not_offered');
        wire.write('STARTTLS\r\n');
        const go = await wire.read(step);
        if (go.code !== 220) throw new SmtpFailure('smtp_tls_failed', 'starttls_not_offered');
        const plain = wire.detach();
        const secured = await upgrade(plain, config.host, step, options.tls);
        wire = new Wire(secured, true);
        caps = await ehlo();
      }
      const w = wire as Wire;
      const expectNow = async (ok: (code: number) => boolean, failure: () => SmtpFailure, timeout = step) => {
        const reply = await w.read(timeout);
        if (!ok(reply.code)) throw failure();
        return reply;
      };

      if (config.user !== undefined && config.user !== '') {
        // A password only ever travels over an encrypted connection (or to a relay on this machine).
        if (!w.inSecure && !target.loopback) throw new SmtpFailure('smtp_tls_failed', 'login_needs_tls');
        const mechs = caps.filter((c) => c.startsWith('AUTH ') || c.startsWith('AUTH=')).flatMap((c) => c.slice(5).trim().split(/\s+/));
        const authFailed = (hint?: MailHint) => () => new SmtpFailure('smtp_auth_failed', hint);
        const password = config.password ?? '';
        if (mechs.includes('PLAIN')) {
          w.write(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${password}`).toString('base64')}\r\n`);
          await expectNow((c) => c === 235, authFailed());
        } else if (mechs.includes('LOGIN')) {
          w.write('AUTH LOGIN\r\n');
          await expectNow((c) => c === 334, authFailed());
          w.write(`${Buffer.from(config.user).toString('base64')}\r\n`);
          await expectNow((c) => c === 334, authFailed());
          w.write(`${Buffer.from(password).toString('base64')}\r\n`);
          await expectNow((c) => c === 235, authFailed());
        } else throw new SmtpFailure('smtp_auth_failed', 'no_auth_mechanism');
      }

      const size = caps.map((c) => /^SIZE (\d+)$/.exec(c)).find(Boolean)?.[1];
      if (size && Number(size) > 0 && Buffer.byteLength(message.data) > Number(size)) throw new SmtpFailure('smtp_rejected', 'message_too_large');

      const rejected = () => new SmtpFailure('smtp_rejected');
      w.write(`MAIL FROM:<${message.envelopeFrom}>\r\n`);
      await expectNow((c) => c === 250, rejected);
      for (const to of message.envelopeTo) {
        w.write(`RCPT TO:<${to}>\r\n`);
        await expectNow((c) => c === 250 || c === 251, rejected);
      }
      w.write('DATA\r\n');
      await expectNow((c) => c === 354, rejected);
      w.write(dataPayload(message.data));
      await expectNow((c) => c === 250, rejected, step * 2);
      try {
        w.write('QUIT\r\n');
      } catch {
        // The message is accepted; a failed goodbye changes nothing.
      }
      return { ok: true };
    };
    return await Promise.race([run(), deadline]);
  } catch (error) {
    if (error instanceof SmtpFailure) return { ok: false, code: error.code, ...(error.hint ? { hint: error.hint } : {}) };
    return { ok: false, code: 'smtp_connection_failed' };
  } finally {
    if (giveUp) clearTimeout(giveUp);
    wire?.socket.destroy();
  }
}

/** The whole job: check the message and the host, then deliver. */
export async function sendViaSmtp(config: SmtpConfig, input: MailInput, options: SmtpOptions = {}): Promise<MailResult> {
  const from = parseMailbox(config.from);
  if (!from) return { ok: false, code: 'smtp_rejected', hint: 'invalid_address' };
  const built = buildMessage({ from, to: Array.isArray(input.to) ? input.to : [input.to], subject: input.subject, text: input.text, ...(input.html === undefined ? {} : { html: input.html }), now: (options.now ?? Date.now)() });
  if (!built.ok) return { ok: false, code: 'smtp_rejected', hint: built.hint };
  const target = await checkMailHost(config.host, options);
  if (!target.ok) return { ok: false, code: 'smtp_connection_failed', hint: target.hint };
  return deliver(config, target, built, options);
}
