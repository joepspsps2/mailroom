import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHttpFrom, lookup, purgeLedger, retentionDays, send } from '../src/core.ts';
import { fakeFetch, memoryDb } from './helpers.ts';

const base = (db: ReturnType<typeof memoryDb>, now: Date, fetcher = fakeFetch({})) => ({
  db, keys: { resend: 're_x', smtp2go: 's_x' }, fromDomain: 'notify.example.com', fetcher, now: () => now,
});
const req = (key: string) => ({ site: 'shop', key, from: 'app@notify.example.com', to: 'a@example.org', subject: 'hi', html: '<p>hi</p>', text: 'hi' });

test('retentionDays: only positive integers count', () => {
  assert.equal(retentionDays(180), 180);
  assert.equal(retentionDays(' 90 '), 90);
  for (const bad of [undefined, '', 'abc', 0, '0', -5, 1.5, '1.5', null]) assert.equal(retentionDays(bad), null);
});

test('purgeLedger deletes only rows older than the cutoff and never in-flight ones', async () => {
  const db = memoryDb();
  const old = new Date('2026-01-01T00:00:00Z');
  const now = new Date('2026-11-01T00:00:00Z');
  await send(base(db, old), req('old-sent'));
  // 一列「正在寄」且很舊：不能動
  db.raw.exec("INSERT INTO messages (stream,tier,site,dedupe_key,to_email,from_addr,subject,status,attempts,created_at,updated_at) VALUES ('transactional','notify','shop','old-sending','a@example.org','x@y.z','s','sending',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')");
  await send(base(db, now), req('new-sent'));
  db.raw.exec("INSERT INTO webhook_events (id,type,received_at) VALUES ('e1','t','2026-01-01T00:00:00.000Z'),('e2','t','2026-10-31T00:00:00.000Z')");
  const r = await purgeLedger(db, 180, now);
  assert.deepEqual(r, { messages: 1, webhookEvents: 1 });
  assert.equal(await lookup(db, 'shop', 'old-sent'), null);
  assert.ok(await lookup(db, 'shop', 'old-sending'));
  assert.ok(await lookup(db, 'shop', 'new-sent'));
  assert.equal(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM webhook_events').get() as { n: number }).n), 1);
});

test('purgeLedger leaves the suppression list alone and respects the batch limit', async () => {
  const db = memoryDb();
  db.raw.exec("INSERT INTO suppressions (email,reason,source,created_at) VALUES ('a@example.org','hard_bounce','manual','2026-01-01T00:00:00.000Z')");
  for (let i = 0; i < 3; i++) db.raw.exec(`INSERT INTO messages (stream,tier,site,dedupe_key,to_email,from_addr,subject,status,attempts,created_at,updated_at) VALUES ('transactional','notify','shop','k${i}','a@example.org','x@y.z','s','sent',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`);
  const now = new Date('2026-11-01T00:00:00Z');
  assert.equal((await purgeLedger(db, 30, now, 2)).messages, 2);
  assert.equal((await purgeLedger(db, 30, now, 2)).messages, 1);
  assert.equal(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM suppressions').get() as { n: number }).n), 1);
});

test('retry that succeeds keeps the previous failure reason in last_error', async () => {
  const db = memoryDb();
  const t = new Date('2026-11-01T00:00:00Z');
  const failed = await send(base(db, t, fakeFetch({ resend: 500, smtp2go: 'fail' })), req('k1'));
  assert.equal(failed.status, 'failed');
  const before = await lookup(db, 'shop', 'k1');
  assert.ok(before?.error);
  assert.equal(before?.last_error, null);
  const ok = await send(base(db, t, fakeFetch({})), req('k1'));
  assert.equal(ok.status, 'sent');
  const after = await lookup(db, 'shop', 'k1');
  assert.equal(after?.error, null);
  assert.equal(after?.last_error, before?.error);
  assert.equal(after?.attempts, 2);
});

test('a second failure then success still keeps the most recent failure reason', async () => {
  const db = memoryDb();
  const t = new Date('2026-11-01T00:00:00Z');
  await send(base(db, t, fakeFetch({ resend: 500, smtp2go: 'fail' })), req('k2'));
  await send(base(db, t, fakeFetch({ resend: 'throw', smtp2go: 'throw' })), req('k2'));
  const mid = await lookup(db, 'shop', 'k2');
  await send(base(db, t, fakeFetch({})), req('k2'));
  const after = await lookup(db, 'shop', 'k2');
  assert.equal(after?.last_error, mid?.error);
});

test('checkHttpFrom: no allowlist for the site means refuse', () => {
  assert.equal(checkHttpFrom(undefined, 'shop', 'a@notify.example.com'), 'allowlist_required');
  assert.equal(checkHttpFrom({}, 'shop', 'a@notify.example.com'), 'allowlist_required');
  assert.equal(checkHttpFrom({ other: ['a@notify.example.com'] }, 'shop', 'a@notify.example.com'), 'allowlist_required');
  assert.equal(checkHttpFrom({ shop: [] }, 'shop', 'a@notify.example.com'), 'allowlist_required');
  assert.equal(checkHttpFrom({ shop: ['A@Notify.Example.com'] }, 'shop', 'Shop <a@notify.example.com>'), null);
  assert.equal(checkHttpFrom({ shop: ['a@notify.example.com'] }, 'shop', 'b@notify.example.com'), 'from_not_allowed');
  assert.equal(checkHttpFrom({ shop: ['a@notify.example.com'] }, 'shop', undefined), 'from_not_allowed');
});
