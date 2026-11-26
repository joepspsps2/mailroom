import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, handleEvent } from '../src/webhook.ts';
import { suppressedReason } from '../src/core.ts';
import { memoryDb } from './helpers.ts';

const SECRET = 'whsec_' + Buffer.from('test-webhook-signing-secret-01').toString('base64');

async function sign(id: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey('raw', Buffer.from(SECRET.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`))).toString('base64');
  return `v1,${sig}`;
}

test('簽章：對的過、內容被改不過、時間太舊不過、沒設 secret 不過', async () => {
  const now = Math.floor(Date.now() / 1000);
  const body = '{"type":"email.delivered"}';
  const sig = await sign('msg_1', String(now), body);
  assert.equal(await verifySignature(SECRET, 'msg_1', String(now), `v1,AAAA ${sig}`, body, now), true);
  assert.equal(await verifySignature(SECRET, 'msg_1', String(now), sig, body + ' ', now), false);
  assert.equal(await verifySignature(SECRET, 'msg_1', String(now), sig, body, now + 600), false);
  assert.equal(await verifySignature('', 'msg_1', String(now), sig, body, now), false);
});

test('永久退信進拒收名單（擋通知信）；暫時退信不進；同一則通知只處理一次', async () => {
  const db = memoryDb();
  db.raw.prepare("INSERT INTO messages (stream, site, dedupe_key, to_email, from_addr, subject, status, provider_id, created_at, updated_at) VALUES ('transactional','billing','k','gone@example.com','x','s','sent','re_9','t','t')").run();
  const ev = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_9', to: ['Gone@Example.com'], bounce: { type: 'Permanent', subType: 'General', message: 'no such user' } } });
  assert.equal(await handleEvent(db, 'msg_a', ev), 'hard_bounce:1');
  assert.equal(await handleEvent(db, 'msg_a', ev), 'repeat');
  assert.equal(await suppressedReason(db, 'gone@example.com', 'transactional'), 'hard_bounce');
  assert.equal((db.raw.prepare("SELECT last_event FROM messages WHERE provider_id='re_9'").get() as { last_event: string }).last_event, 'bounced');
  const soft = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_8', to: ['full@example.com'], bounce: { type: 'Transient' } } });
  assert.equal(await handleEvent(db, 'msg_b', soft), 'bounce_transient');
  assert.equal(await suppressedReason(db, 'full@example.com', 'transactional'), null);
});

test('檢舉進拒收名單；送達只更新帳本', async () => {
  const db = memoryDb();
  assert.equal(await handleEvent(db, 'm1', JSON.stringify({ type: 'email.complained', data: { email_id: 're_1', to: ['x@example.com'] } })), 'complaint:1');
  assert.equal(await suppressedReason(db, 'x@example.com', 'transactional'), 'complaint');
  assert.equal(await handleEvent(db, 'm2', JSON.stringify({ type: 'email.delivered', data: { email_id: 're_1', to: ['y@example.com'] } })), 'event:delivered');
  assert.equal(await suppressedReason(db, 'y@example.com', 'transactional'), null);
});

test('Resend 的檢舉與永久退信也走 applyFeedback：從所有電子報名單退訂（檢舉）、清暫時退信紀錄', async () => {
  const { listDb } = await import('./lists-helpers.ts');
  const { upsertList, listSubscribe } = await import('../src/lists.ts');
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly' });
  await listSubscribe(db, { list: 'weekly', email: 'x@example.com' });
  await handleEvent(db, 'c1', JSON.stringify({ type: 'email.complained', data: { email_id: 're_9', to: ['X@example.com'] } }));
  const row = db.raw.prepare('SELECT status, unsub_source FROM list_members').get() as { status: string; unsub_source: string };
  assert.deepEqual({ ...row }, { status: 'unsubscribed', unsub_source: 'complaint' });
});
