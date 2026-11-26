// 群發的零件：事件進來、假郵差、設定、遷移、管理入口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { DOMAIN, makeWorld } from './broadcast-helpers.ts';
import { send } from '../src/core.ts';
import { FakePostman, ingestEvent, resolveConfig, DEFAULT_BROADCAST_CONFIG, type ProviderEvent } from '../src/broadcast/index.ts';
import { handleBroadcastRequest, isBroadcastPath } from '../src/broadcast/routes.ts';

test('事件：同一則重送只記一次；永久退信、檢舉進拒收；暫時退信不進；可注入自己的處理', async () => {
  const w = await makeWorld({ members: 1 });
  const ev = (id: string, type: ProviderEvent['type'], email: string, subtype?: string): ProviderEvent => ({ provider: 'fake', providerEventId: id, type, subtype, email, at: w.now().toISOString() });
  assert.equal(await ingestEvent(w.db, ev('e1', 'bounce', 'a@example.com', 'Permanent')), 'recorded');
  assert.equal(await ingestEvent(w.db, ev('e1', 'bounce', 'a@example.com', 'Permanent')), 'repeat');
  assert.equal(w.count('events'), 1);
  await ingestEvent(w.db, ev('e2', 'bounce', 'b@example.com', 'Transient'));
  await ingestEvent(w.db, ev('e3', 'complaint', 'c@example.com'));
  const sup = (await w.db.prepare('SELECT email, reason FROM suppressions ORDER BY email').all<{ email: string; reason: string }>()).results.map((r) => `${r.email}:${r.reason}`);
  assert.deepEqual(sup, ['a@example.com:hard_bounce', 'c@example.com:complaint']);
  const got: unknown[] = [];
  await ingestEvent(w.db, { ...ev('e4', 'bounce', 'd@example.com', 'Transient'), campaign: 'x-1' }, { feedback: async (fb) => void got.push(fb) });
  assert.deepEqual(got, [{ type: 'bounce', kind: 'transient', email: 'd@example.com', campaign: 'x-1', source: 'fake-event', detail: 'Transient' }]);
  assert.equal(await ingestEvent(w.db, { ...ev('e5', 'send', 'x@example.com'), type: 'nope' as never }), 'rejected');
  assert.equal(await ingestEvent(w.db, { ...ev('', 'send', 'x@example.com') }), 'rejected');
});

test('事件比帳本回寫郵差 id 更早回來：靠去重鍵仍對得到帳本列', async () => {
  const w = await makeWorld({ members: 2, config: { paceMinutes: 1 } });
  await w.campaign('ev-1');
  await w.run(2);
  const row = await w.db.prepare("SELECT message_id, provider_message_id FROM events WHERE campaign_id = 'ev-1' AND type = 'send' AND contact_id = 1").first<{ message_id: number; provider_message_id: string }>();
  assert.ok(row?.message_id, 'send event linked to ledger row');
  assert.match(row.provider_message_id, /^fake-/);
  const m = await w.db.prepare("SELECT last_event FROM messages WHERE dedupe_key = 'c:ev-1:1'").first<{ last_event: string }>();
  assert.equal(m?.last_event, 'delivered');
});

test('假郵差：照模擬信箱地址決定結果、rules 可指定次數、限流／帳號被停不算收下', async () => {
  const events: ProviderEvent[] = [];
  const p = new FakePostman({ emit: (e) => void events.push(e), rules: [{ match: 'flaky', outcome: 'temporary', times: 1 }, { match: /@slow\./, outcome: 'delay' }] });
  const mail = (to: string) => ({ from: 'a@mail.example.com', to, subject: 's', html: 'h', text: 't', tags: { campaign: 'c', contact: '1' }, idempotencyKey: 'k' });
  assert.equal((await p.send(mail('success@simulator.example'))).ok, true);
  await p.send(mail('bounce@simulator.example'));
  await p.send(mail('complaint+7@simulator.example'));
  await p.send(mail('suppressionlist@simulator.example'));
  await p.send(mail('x@slow.example'));
  assert.deepEqual(await p.send(mail('flaky@example.com')), { ok: false, kind: 'temporary', error: 'fake temporary failure' });
  assert.equal((await p.send(mail('flaky@example.com'))).ok, true, 'times:1 only once');
  const types = events.map((e) => `${e.email}:${e.type}${e.subtype ? `:${e.subtype}` : ''}`);
  assert.deepEqual(types, [
    'success@simulator.example:send', 'success@simulator.example:delivery',
    'bounce@simulator.example:send', 'bounce@simulator.example:bounce:Permanent',
    'complaint+7@simulator.example:send', 'complaint+7@simulator.example:delivery', 'complaint+7@simulator.example:complaint',
    'suppressionlist@simulator.example:send', 'suppressionlist@simulator.example:bounce:Permanent',
    'x@slow.example:send', 'x@slow.example:delay', 'x@slow.example:delivery',
    'flaky@example.com:send', 'flaky@example.com:delivery',
  ]);
  assert.equal(new Set(events.map((e) => e.providerEventId)).size, events.length);
  const p2 = new FakePostman({ rules: [{ match: 'a', outcome: 'throttle' }, { match: 'b', outcome: 'account_paused' }, { match: 'c', outcome: 'crash' }] });
  assert.equal((await p2.send(mail('a@x.example'))).ok, false);
  assert.deepEqual(await p2.send(mail('b@x.example')), { ok: false, kind: 'account_paused', error: 'fake account paused' });
  await assert.rejects(p2.send(mail('c@x.example')));
  assert.equal(p2.accepted.length, 0);
  assert.deepEqual(await new FakePostman({ limits: { perSecond: 1, perDay: 200 } }).limits(), { perSecond: 1, perDay: 200, enforcement: 'HEALTHY', sentLast24h: undefined });
});

test('設定：只收型別對、範圍合理的值；寫錯一律用預設（不能變成不設防）', () => {
  assert.deepEqual(resolveConfig(undefined), { ...DEFAULT_BROADCAST_CONFIG });
  const c = resolveConfig({ maxPerDay: 500, brakeHardBounceRate: 0.03, site: 'news-letter' });
  assert.deepEqual([c.maxPerDay, c.brakeHardBounceRate, c.site], [500, 0.03, 'news-letter']);
  const bad = resolveConfig({ maxPerDay: -1, brakeHardBounceRate: 4, brakeMinSent: 'many' as never, site: 'Bad Site', utcOffsetHours: 99 });
  assert.deepEqual([bad.maxPerDay, bad.brakeHardBounceRate, bad.brakeMinSent, bad.site, bad.utcOffsetHours], [3000, 0.04, 200, 'newsletter', 8]);
  assert.equal(resolveConfig('{"maxPerDay":"1200"}').maxPerDay, 1200);
  assert.equal(resolveConfig('{not json').maxPerDay, 3000);
});

test('遷移 0006：重建帳本表後舊資料一列不少、欄位不變；新的 tier marketing 寫得進去、亂寫的擋下', () => {
  const raw = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  for (const f of files.filter((n) => n < '0006')) raw.exec(readFileSync(new URL(f, dir), 'utf8'));
  raw.exec(`INSERT INTO messages (stream, site, dedupe_key, kind, to_email, from_addr, subject, status, route, provider_id, error, attempts, last_event, created_at, updated_at, sent_at, tier, last_error)
    VALUES ('transactional', 'shop', 'k1', 'invite', 'a@example.com', 'x@notify.example.com', 's', 'sent', 'resend', 're_1', NULL, 2, 'delivered', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z', 'remind', 'old')`);
  const before = raw.prepare('SELECT * FROM messages').all();
  const colsBefore = (raw.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name).sort();
  for (const f of files.filter((n) => n >= '0006')) raw.exec(readFileSync(new URL(f, dir), 'utf8'));
  assert.deepEqual(raw.prepare('SELECT * FROM messages').all(), before);
  assert.deepEqual((raw.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name).sort(), colsBefore);
  const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ['messages_created', 'messages_marketing_sent', 'messages_provider', 'messages_tier', 'messages_to']);
  raw.exec(`INSERT INTO messages (stream, tier, site, dedupe_key, to_email, from_addr, subject, status, created_at, updated_at) VALUES ('marketing', 'marketing', 'newsletter', 'c:x:1', 'a@example.com', 'n@mail.example.com', 's', 'sent', 't', 't')`);
  assert.throws(() => raw.exec(`INSERT INTO messages (stream, tier, site, dedupe_key, to_email, from_addr, subject, status, created_at, updated_at) VALUES ('marketing', 'bogus', 'newsletter', 'c:x:2', 'a@example.com', 'n@mail.example.com', 's', 'sent', 't', 't')`));
  // 新的 id 不會跟舊的撞
  const ids = (raw.prepare('SELECT id FROM messages ORDER BY id').all() as { id: number }[]).map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('遷移裡的 LIKE／GLOB 樣式都很短（D1 上限約 50 bytes，本機 SQLite 測不出來）', () => {
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
    const sql = readFileSync(new URL(f, dir), 'utf8');
    for (const m of sql.matchAll(/\b(?:LIKE|GLOB)\s+'([^']*)'/gi)) assert.ok(Buffer.byteLength(m[1]) <= 30, `${f}: ${m[1]}`);
  }
});

test('掛號櫃台照舊：一般寄信入口仍然不收電子報（stream marketing）', async () => {
  const w = await makeWorld({ members: 0 });
  const r = await send({ db: w.db, keys: {}, fromDomain: 'notify.example.com' }, { site: 'shop', key: 'k', stream: 'marketing', from: 'a@notify.example.com', to: 'b@example.com', subject: 's', html: 'h', text: 't' });
  assert.deepEqual(r, { status: 'rejected', retryable: false, reason: 'stream_closed' });
});

test('管理入口：存草稿、記檢查、核准、排程、查進度、節流狀態；不歸群發的路徑不接', async () => {
  const w = await makeWorld({ members: 3 });
  const deps = { db: w.db, domain: DOMAIN, now: w.now };
  const call = async (method: string, path: string, body?: unknown) => {
    const req = new Request(`https://mailroom.example.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handleBroadcastRequest(req, new URL(req.url), deps);
    return res ? { status: res.status, body: await res.json() } : null;
  };
  assert.equal(isBroadcastPath('/v1/campaigns/weekly-1'), true);
  assert.equal(isBroadcastPath('/v1/campaigns/Bad_Id'), false);
  assert.equal(isBroadcastPath('/v1/send'), false);
  const draft = { list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: '<p>x</p>', text: 'x', audience: { waves: [['*']] } };
  assert.equal((await call('PUT', '/v1/campaigns/api-1', draft))?.status, 200);
  assert.equal((await call('POST', '/v1/campaigns/api-1/schedule', { at: w.now().toISOString() }))?.status, 409);
  assert.equal((await call('POST', '/v1/campaigns/api-1/preflight', { ok: true, issues: [] }))?.status, 200);
  assert.equal((await call('POST', '/v1/campaigns/api-1/approve', { note: 'owner ok' }))?.status, 200);
  const sch = await call('POST', '/v1/campaigns/api-1/schedule', { at: w.now().toISOString() });
  assert.equal(sch?.status, 200);
  const st = await call('GET', '/v1/campaigns/api-1');
  assert.equal((st?.body as { status: string }).status, 'scheduled');
  assert.equal(JSON.stringify(st?.body).includes('<p>x</p>'), false, '進度不回內文');
  assert.equal((await call('GET', '/v1/campaigns/none-1'))?.status, 404);
  const th = await call('GET', '/v1/throttle');
  assert.equal((th?.body as { domain: string }).domain, DOMAIN);
  assert.equal((await call('POST', '/v1/warmup/p1/unblock', { note: '' }))?.status, 400);
  assert.equal((await call('PUT', '/v1/warmup/p1/1', { waves: [['core']] }))?.status, 200);
  assert.equal(((await call('GET', '/v1/warmup/p1'))?.body as { steps: unknown[] }).steps.length, 1);
  assert.equal(await call('DELETE', '/v1/campaigns/api-1'), null);
  assert.equal((await call('POST', '/v1/broadcast/release-hold', { note: 'x' }))?.status, 200);
});
