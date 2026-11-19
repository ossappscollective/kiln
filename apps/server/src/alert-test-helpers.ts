import type { Database } from '@mrm/db';
import { claimNext, completeJob, failJob } from './jobs.ts';
import { bootRepoApp } from './repo-test-helpers.ts';
import { createAlertDeliveryHandler } from './services/alert-delivery.ts';
import { ALERT_QUEUE } from './services/alerts.ts';
import { emitEvent } from './services/events.ts';
import type { MailInput, MailResult } from './services/mailer.ts';

/** A fake mailer: records what it was asked to send and answers from a script. */
export function fakeMail() {
  const sent: MailInput[] = [];
  const script: MailResult[] = [];
  const send = async (input: MailInput): Promise<MailResult> => {
    sent.push(input);
    return script.shift() ?? { ok: true };
  };
  return { sent, script, send };
}

/** An app booted with alerts: an owner, a way to add people, an app row, and a runner for the alert email jobs. */
export async function bootAlerts(db: Database, overrides: Parameters<typeof bootRepoApp>[2] = {}) {
  const t = await bootRepoApp(db, undefined, overrides);
  const mail = fakeMail();
  const handler = createAlertDeliveryHandler({ db, now: Date.now, sendMail: mail.send, maxAttempts: 3 });
  const [owner] = await db.query("SELECT user_id FROM workspace_members WHERE role = 'owner'");
  const ownerId = String(owner?.user_id);
  const addApp = async (id = 'app1', name = 'Moon Diary') => {
    await db.execute(
      'INSERT INTO apps (id, workspace_id, name, platform, identifier, credential_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, t.workspaceId, name, 'ios', `com.example.${id}`, 'cred', 1],
    );
    return id;
  };
  /** Runs the alert email jobs that are due at `at`, the way the worker does. Returns how many ran. */
  const runMail = async (at = Date.now() + 1000) => {
    let ran = 0;
    for (let job = await claimNext(db, at); job; job = await claimNext(db, at)) {
      if (job.queue !== ALERT_QUEUE) continue;
      ran++;
      try {
        await handler(job.payload, job);
        await completeJob(db, job);
      } catch (error) {
        await failJob(db, job, error, { maxAttempts: 3, now: at });
      }
    }
    return ran;
  };
  const emit = (type: Parameters<typeof emitEvent>[1]['type'], payload: Record<string, unknown>, appId?: string, at = Date.now()) =>
    emitEvent(db, { workspaceId: t.workspaceId, type, subject: appId ? { appId } : {}, payload, at });
  const rejected = (appId: string, version = '2.0', at = Date.now()) =>
    emit('app.release.status_changed', { version, track: '', build: '7', from: 'in_review', to: 'rejected' }, appId, at);
  const alerts = async () => db.query('SELECT * FROM alerts WHERE is_test = 0 ORDER BY first_at, id');
  const inbox = async (userId = ownerId) => db.query('SELECT * FROM alert_inbox WHERE user_id = ?', [userId]);
  const log = async (where = '1 = 1') => db.query(`SELECT * FROM alert_deliveries WHERE ${where} ORDER BY created_at, id`);
  return { ...t, mail, handler, ownerId, addApp, runMail, emit, rejected, alerts, inbox, log };
}
export type AlertBoot = Awaited<ReturnType<typeof bootAlerts>>;
