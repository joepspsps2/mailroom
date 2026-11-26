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
  assert.equal((await p.send(mail('success@example.com'))).ok, true);
  await p.send(mail('bounce@example.com'));
  await p.send(mail('complaint+7@example.com'));
  await p.send(mail('suppressionlist@example.com'));
  await p.send(mail('x@slow.example.com'));
  assert.deepEqual(await p.send(mail('flaky@example.com')), { ok: false, kind: 'temporary', error: 'fake temporary failure' });
  assert.equal((await p.send(mail('flaky@example.com'))).ok, true, 'times:1 only once');
  const types = events.map((e) => `${e.email}:${e.type}${e.subtype ? `:${e.subtype}` : ''}`);
  assert.deepEqual(types, [
    'success@example.com:send', 'success@example.com:delivery',
    'bounce@example.com:send', 'bounce@example.com:bounce:Permanent',
    'complaint+7@example.com:send', 'complaint+7@example.com:delivery', 'complaint+7@example.com:complaint',
    'suppressionlist@example.com:send', 'suppressionlist@example.com:bounce:Permanent',
    'x@slow.example.com:send', 'x@slow.example.com:delay', 'x@slow.example.com:delivery',
    'flaky@example.com:send', 'flaky@example.com:delivery',
  ]);
  assert.equal(new Set(events.map((e) => e.providerEventId)).size, events.length);
  const p2 = new FakePostman({ rules: [{ match: 'a', outcome: 'throttle' }, { match: 'b', outcome: 'account_paused' }, { match: 'c', outcome: 'crash' }] });
  assert.equal((await p2.send(mail('a@example.com'))).ok, false);
  assert.deepEqual(await p2.send(mail('b@example.com')), { ok: false, kind: 'account_paused', error: 'fake account paused' });
  await assert.rejects(p2.send(mail('c@example.com')));
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
  const draft = { list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: '<p>x</p>', text: 'x', webUrl: 'https://www.example.com/i/1', audience: { waves: [['*']] } };
  assert.equal((await call('PUT', '/v1/campaigns/api-1', draft))?.status, 200);
  assert.equal((await call('POST', '/v1/campaigns/api-1/schedule', { at: w.now().toISOString() }))?.status, 409);
  assert.equal((await call('POST', '/v1/campaigns/api-1/preflight', { ok: true, issues: [] }))?.status, 200);
  assert.equal((await call('POST', '/v1/campaigns/api-1/approve', { note: 'owner ok' }))?.status, 409, '沒有預覽不能核准');
  assert.equal((await call('POST', '/v1/campaigns/api-1/preview', {}))?.status, 200);
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

test('Worker 預設個人化：每位收件人一張退訂券（連結＋一鍵退訂標頭）；沒設退訂鑰匙＝這期暫停、一封都不寄', async () => {
  const { personalizeRender, unsubLinksFromEnv } = await import('../src/broadcast/worker.ts');
  const { verifyUnsubToken } = await import('../src/unsub.ts');
  const secret = 'test-secret-0123456789abcdef';
  const env = { DB: null as never, UNSUB_TOKEN_SECRET: secret, UNSUB_BASE_URL: 'https://u.example.com', UNSUB_MAILTO: 'unsub@mail.example.com' };
  const w = await makeWorld({ members: 2, config: { paceMinutes: 1 } });
  w.deps.render = personalizeRender(unsubLinksFromEnv(env));
  const { saveDraft, recordPreflight, approveCampaign, scheduleCampaign } = await import('../src/broadcast/index.ts');
  const opts = { marketingDomain: DOMAIN, now: w.now };
  await saveDraft(w.db, {
    id: 'pz-1', list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, webUrl: 'https://www.example.com/i/pz-1',
    html: '<p>Hi {{#name}}{{name}}{{/name}} <a href="{{unsubscribe_url}}">unsubscribe</a> <a href="{{web_url}}">web</a></p>', text: 'bye {{unsubscribe_url}}',
    headers: { 'List-Unsubscribe': '<{{unsubscribe_url}}>, <{{unsubscribe_mailto}}>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    audience: { waves: [['*']] },
  }, opts);
  await recordPreflight(w.db, 'pz-1', { ok: true }, w.now);
  await approveCampaign(w.db, 'pz-1', 'ok', w.now);
  await scheduleCampaign(w.db, 'pz-1', w.now().toISOString(), w.now);
  await w.run(5);
  assert.equal((await w.status('pz-1')).status, 'done');
  const m = w.postman.accepted[0];
  const token = /\/u\/([^"\s>]+)/.exec(m.html)![1];
  const claims = await verifyUnsubToken([secret], token);
  assert.deepEqual({ list: claims?.list, campaign: claims?.campaign }, { list: 'weekly', campaign: 'pz-1' });
  assert.ok(m.html.includes('https://www.example.com/i/pz-1'));
  assert.match(m.headers?.['List-Unsubscribe'] ?? '', /^<https:\/\/u\.example\.com\/u\/.+>, <mailto:unsub@mail\.example\.com\?subject=.+>$/);
  assert.equal(m.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  const w2 = await makeWorld({ members: 2, config: { paceMinutes: 1 } });
  w2.deps.render = personalizeRender(unsubLinksFromEnv({ DB: null as never }));
  await w2.campaign('pz-2');
  await w2.run(3);
  assert.match((await w2.status('pz-2')).pause_reason ?? '', /^render_error:unsubscribe links not configured/);
  assert.equal(w2.postman.accepted.length, 0);
});

test('排程前一定要有網頁版網址', async () => {
  const w = await makeWorld({ members: 1 });
  const { saveDraft, recordPreflight, approveCampaign, scheduleCampaign } = await import('../src/broadcast/index.ts');
  const opts = { marketingDomain: DOMAIN, now: w.now };
  await saveDraft(w.db, { id: 'nw-1', list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: 'h', text: 't', audience: { waves: [['*']] } }, opts);
  await recordPreflight(w.db, 'nw-1', { ok: true }, w.now);
  await approveCampaign(w.db, 'nw-1', 'ok', w.now);
  assert.deepEqual(await scheduleCampaign(w.db, 'nw-1', w.now().toISOString(), w.now), { ok: false, reason: 'web_url_required' });
  assert.deepEqual(await saveDraft(w.db, { id: 'nw-2', list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: 'h', text: 't', webUrl: 'http://x.example.com', audience: { waves: [['*']] } }, opts), { ok: false, reason: 'bad_web_url' });
});

test('事件預設處理＝退訂模組的 applyFeedback：檢舉的人所有名單都退訂', async () => {
  const w = await makeWorld({ members: 2 });
  await ingestEvent(w.db, { provider: 'fake', providerEventId: 'cx', type: 'complaint', email: 'r0@example.com', at: w.now().toISOString() });
  const m = await w.db.prepare("SELECT m.status, m.unsub_source FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'r0@example.com'").first<Record<string, unknown>>();
  assert.deepEqual({ ...m }, { status: 'unsubscribed', unsub_source: 'complaint' });
});

test('一期信自帶的標頭只收允許的名稱（不能夾帶寄件人、收件人、主旨）', async () => {
  const w = await makeWorld({ members: 1 });
  const { saveDraft } = await import('../src/broadcast/index.ts');
  const opts = { marketingDomain: DOMAIN, now: w.now };
  const base = { list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: 'h', text: 't', audience: { waves: [['*']] } };
  for (const bad of ['Bcc', 'From', 'reply-to', 'Subject', 'Content-Type', 'Return-Path', 'To']) {
    assert.deepEqual(await saveDraft(w.db, { ...base, id: 'hd-1', headers: { [bad]: 'x@example.com' } }, opts), { ok: false, reason: 'bad_headers' }, bad);
  }
  assert.equal((await saveDraft(w.db, { ...base, id: 'hd-1', headers: { 'List-Unsubscribe': '<{{unsubscribe_url}}>', 'List-Id': 'weekly.example.com', 'X-Campaign': 'hd-1' } }, opts)).ok, true);
  // render 換掉後產生不允許的標頭：寄送端再擋一次，不交郵差、這期暫停
  w.deps.render = (c) => ({ html: c.html, text: c.text, headers: { Bcc: 'spy@example.com' } });
  await w.db.prepare("UPDATE campaigns SET web_url = 'https://www.example.com/x' WHERE id = 'hd-1'").run();
  const { recordPreflight, approveCampaign, scheduleCampaign } = await import('../src/broadcast/index.ts');
  await recordPreflight(w.db, 'hd-1', { ok: true }, w.now);
  await approveCampaign(w.db, 'hd-1', 'ok', w.now);
  await scheduleCampaign(w.db, 'hd-1', w.now().toISOString(), w.now);
  await w.run(3);
  assert.equal(w.postman.accepted.length, 0);
  assert.match((await w.status('hd-1')).pause_reason ?? '', /^rejected:bad_header/);
});

test('郵差回報的退訂事件：退掉那一期所屬的名單', async () => {
  const w = await makeWorld({ members: 2, config: { paceMinutes: 1 } });
  await w.campaign('us-1');
  await w.run(3);
  await ingestEvent(w.db, { provider: 'fake', providerEventId: 'u1', type: 'unsubscribe', email: 'r1@example.com', campaign: 'us-1', contact: '2', at: w.now().toISOString() });
  const m = await w.db.prepare("SELECT m.status FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE c.email = 'r1@example.com'").first<{ status: string }>();
  assert.equal(m?.status, 'unsubscribed');
});
