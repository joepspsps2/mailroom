// 群發：完整一期、狀態機、凍結、重送／中斷不重寄。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN, makeWorld } from './broadcast-helpers.ts';
import { addSuppression } from '../src/core.ts';
import { listSubscribe, listUnsubscribe } from '../src/lists.ts';
import {
  approveCampaign, canTransition, cancelCampaign, CAMPAIGN_STATUSES, consume, pauseCampaign, reconcileCampaign, recordPreflight, resolveConfig, resolveUncertain,
  resumeCampaign, saveDraft, scheduleCampaign, tick, TRANSITIONS, unscheduleCampaign, type CampaignStatus,
} from '../src/broadcast/index.ts';

const input = (id: string, extra: Record<string, unknown> = {}) => ({
  id, list: 'weekly', subject: 'Hello', from: `Weekly <news@${DOMAIN}>`, html: '<p>hi</p>', text: 'hi', audience: { waves: [['*']] }, ...extra,
});

test('完整一期：開寄→分批交郵差→每人一封→對帳→done', async () => {
  const w = await makeWorld({ members: 50 }); // 預設配速 150 分鐘：50 人＝每分鐘 1 人
  await w.campaign('w-1');
  await w.run(200, { until: async () => (await w.status('w-1')).status === 'done' });
  assert.equal((await w.status('w-1')).status, 'done');
  assert.equal(w.postman.accepted.length, 50);
  assert.equal(w.maxPerAddress(), 1);
  assert.equal(w.count('messages', "stream = 'marketing' AND tier = 'marketing' AND status = 'sent'"), 50);
  const rec = await reconcileCampaign(w.db, 'w-1', resolveConfig());
  assert.equal(rec.ok, true, rec.problems.join(','));
  assert.equal(rec.frozen, 50);
  assert.equal(rec.sent, 50);
  assert.equal(rec.events.sends, 50);
  assert.equal(rec.events.delivered, 50);
  assert.ok(w.alerts.some((a) => a.startsWith('info:finished:w-1')));
});

test('狀態機：每一組 (from, to) 都照表允許或拒絕', () => {
  const allowed = new Set(Object.entries(TRANSITIONS).flatMap(([f, ts]) => ts.map((t) => `${f}>${t}`)));
  for (const f of CAMPAIGN_STATUSES) for (const t of CAMPAIGN_STATUSES) assert.equal(canTransition(f, t), allowed.has(`${f}>${t}`), `${f}>${t}`);
  // 終點狀態走不出去；寄送中不能直接取消（要先暫停）；排程不能跳過核准。
  for (const t of CAMPAIGN_STATUSES) {
    assert.equal(canTransition('done', t), false);
    assert.equal(canTransition('cancelled', t), false);
  }
  assert.equal(canTransition('sending', 'cancelled'), false);
  assert.equal(canTransition('draft', 'scheduled'), false);
  assert.equal(canTransition('draft', 'sending'), false);
});

test('狀態機：非法轉換一律擋下', async () => {
  const w = await makeWorld({ members: 3, config: { paceMinutes: 1 } });
  const opts = { marketingDomain: DOMAIN, now: w.now };
  assert.equal((await saveDraft(w.db, input('s-1'), opts)).ok, true);
  const at = new Date(w.clock.t).toISOString();
  // draft 不能直接排程、暫停、續寄
  assert.deepEqual(await scheduleCampaign(w.db, 's-1', at, w.now), { ok: false, reason: 'illegal_transition', status: 'draft' });
  assert.equal((await pauseCampaign(w.db, 's-1', 'x', w.now)).ok, false);
  assert.equal((await resumeCampaign(w.db, 's-1', 'x', opts)).ok, false);
  // 核准一定要寫 note
  assert.deepEqual(await approveCampaign(w.db, 's-1', '  ', w.now), { ok: false, reason: 'note_required' });
  assert.equal((await approveCampaign(w.db, 's-1', 'owner ok', w.now)).ok, true);
  // 寄前檢查沒過不得排程
  assert.deepEqual(await scheduleCampaign(w.db, 's-1', at, w.now), { ok: false, reason: 'preflight_not_passed' });
  await recordPreflight(w.db, 's-1', { ok: false, issues: [{ severity: 'error', code: 'broken_link' }] }, w.now);
  assert.deepEqual(await scheduleCampaign(w.db, 's-1', at, w.now), { ok: false, reason: 'preflight_not_passed' });
  // 回報 ok 卻帶 error＝當沒過
  const contradictory = await recordPreflight(w.db, 's-1', { ok: true, issues: [{ severity: 'error', code: 'x' }] }, w.now);
  assert.equal(contradictory.ok && contradictory.preflightOk, false);
  assert.deepEqual(await scheduleCampaign(w.db, 's-1', at, w.now), { ok: false, reason: 'preflight_not_passed' });
  await recordPreflight(w.db, 's-1', { ok: true, issues: [] }, w.now);
  assert.equal((await scheduleCampaign(w.db, 's-1', at, w.now)).ok, true);
  // 排程後改內容 → 退回 draft、核准與檢查都清掉
  const changed = await saveDraft(w.db, input('s-1', { subject: 'Hello again' }), opts);
  assert.deepEqual(changed, { ok: true, status: 'draft', changed: true });
  const row = await w.db.prepare('SELECT approved_hash, preflight, scheduled_at FROM campaigns WHERE id = ?').bind('s-1').first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { approved_hash: null, preflight: null, scheduled_at: null });
  // 同樣內容再存一次＝不變（不會把 approved 打回 draft）
  await approveCampaign(w.db, 's-1', 'owner ok again', w.now);
  assert.deepEqual(await saveDraft(w.db, input('s-1', { subject: 'Hello again' }), opts), { ok: true, status: 'approved', changed: false });
  // 檢查過了但之後內容又改：雜湊對不上 → 不能排程
  await recordPreflight(w.db, 's-1', { ok: true }, w.now);
  await saveDraft(w.db, input('s-1', { subject: 'Third' }), opts);
  await approveCampaign(w.db, 's-1', 'owner ok 3', w.now);
  assert.deepEqual(await scheduleCampaign(w.db, 's-1', at, w.now), { ok: false, reason: 'preflight_not_passed' });
  // 已排程後寄前檢查重跑沒過 → 退回 approved
  await recordPreflight(w.db, 's-1', { ok: true }, w.now);
  await scheduleCampaign(w.db, 's-1', at, w.now);
  await recordPreflight(w.db, 's-1', { ok: false, issues: [{ severity: 'error', code: 'x' }] }, w.now);
  assert.equal((await w.status('s-1')).status, 'approved');
  // 取消排程、寄送中不能改內容／取消、done 之後什麼都不行
  await recordPreflight(w.db, 's-1', { ok: true }, w.now);
  await scheduleCampaign(w.db, 's-1', at, w.now);
  assert.equal((await unscheduleCampaign(w.db, 's-1', w.now)).ok, true);
  await scheduleCampaign(w.db, 's-1', at, w.now);
  await w.run(1);
  assert.equal((await w.status('s-1')).status, 'sending');
  assert.deepEqual(await saveDraft(w.db, input('s-1', { subject: 'late edit' }), opts), { ok: false, reason: 'locked', status: 'sending' });
  assert.deepEqual(await cancelCampaign(w.db, 's-1', 'nope', w.now), { ok: false, reason: 'illegal_transition', status: 'sending' });
  assert.equal((await recordPreflight(w.db, 's-1', { ok: true }, w.now)).ok, false);
  await w.run(10, { until: async () => (await w.status('s-1')).status === 'done' });
  assert.equal((await w.status('s-1')).status, 'done');
  for (const f of [pauseCampaign(w.db, 's-1', 'x', w.now), cancelCampaign(w.db, 's-1', 'x', w.now), approveCampaign(w.db, 's-1', 'x', w.now), unscheduleCampaign(w.db, 's-1', w.now)]) {
    assert.equal((await f).ok, false);
  }
  // 寄件地址必須在電子報網域下
  assert.deepEqual(await saveDraft(w.db, input('s-2', { from: 'x@notify.example.com' }), opts), { ok: false, reason: 'bad_from' });
  assert.deepEqual(await saveDraft(w.db, input('s-2', { audience: { waves: [['*', 'core']] } }), opts), { ok: false, reason: 'bad_audience' });
  assert.deepEqual(await saveDraft(w.db, input('s-2', { list: 'nope' }), opts), { ok: false, reason: 'unknown_list' });
});

test('凍結：拒收的人記 skipped／suppressed、退訂的人不入名單、不在收件群的記 warmup、maxCount 截斷、分波順序', async () => {
  const seg = (i: number) => (i < 4 ? 'core' : i < 8 ? 'steady' : 'sleepy');
  const w = await makeWorld({ members: 12, segmentOf: seg });
  await addSuppression(w.db, 'r1@example.com', 'hard_bounce', 'test', null);
  await addSuppression(w.db, 'r5@example.com', 'unsubscribe', 'test', null); // 「全部電子報都不要」
  await listUnsubscribe(w.db, { list: 'weekly', email: 'r2@example.com', source: 'link' });
  await w.campaign('f-1', { waves: [['core'], ['steady']], maxCount: 6 });
  await w.run(1);
  const rows = (await w.db.prepare('SELECT email, wave, state, skip_reason FROM campaign_recipients WHERE campaign_id = ? ORDER BY contact_id').bind('f-1').all<Record<string, unknown>>()).results;
  const by = Object.fromEntries(rows.map((r) => [r.email, r]));
  assert.equal(rows.length, 11, '退訂的 r2 不在凍結名單裡');
  assert.equal(by['r2@example.com'], undefined);
  assert.equal(by['r1@example.com'].skip_reason, 'suppressed');
  assert.equal(by['r5@example.com'].skip_reason, 'suppressed');
  for (const e of ['r8@example.com', 'r9@example.com', 'r10@example.com', 'r11@example.com']) assert.equal(by[e].skip_reason, 'warmup');
  // 可寄的人：core r0 r3（波1），steady r4 r6 r7（波2）＝5 人，maxCount 6 不截
  const planned = rows.filter((r) => r.skip_reason === null);
  assert.deepEqual(planned.map((r) => [r.email, r.wave]), [['r0@example.com', 1], ['r3@example.com', 1], ['r4@example.com', 2], ['r6@example.com', 2], ['r7@example.com', 2]]);

  // maxCount 截斷照波次與順位
  const w2 = await makeWorld({ members: 10, segmentOf: (i) => (i % 2 ? 'b' : 'a') });
  await w2.campaign('f-2', { waves: [['b', 'a']], maxCount: 7 });
  await w2.run(1);
  const r2 = (await w2.db.prepare("SELECT email, rank, state, skip_reason FROM campaign_recipients WHERE campaign_id = ? ORDER BY wave, rank, contact_id").bind('f-2').all<Record<string, unknown>>()).results;
  assert.equal(r2.filter((r) => r.skip_reason === 'warmup').length, 3);
  assert.ok(r2.slice(0, 5).every((r) => r.rank === 0 && r.skip_reason === null), 'b 群（順位 0）全部在名額內');
  assert.deepEqual(r2.filter((r) => r.skip_reason === 'warmup').map((r) => r.email), ['r4@example.com', 'r6@example.com', 'r8@example.com']);
});

test('凍結後才退訂／被拒收的人：派送當下再查一次並跳過；凍結後才訂閱的人不在這期', async () => {
  const w = await makeWorld({ members: 10, config: { paceMinutes: 1000 } }); // 一分鐘只放 1 人，留時間讓名單變動
  await w.campaign('u-1');
  await w.run(1);
  assert.equal(w.postman.accepted.length, 1);
  await listUnsubscribe(w.db, { list: 'weekly', email: 'r5@example.com', source: 'one_click' });
  await addSuppression(w.db, 'r6@example.com', 'complaint', 'test', null);
  await addSuppression(w.db, 'r7@example.com', 'unsubscribe', 'test', null);
  await listSubscribe(w.db, { list: 'weekly', email: 'late@example.com' });
  await w.run(30, { until: async () => (await w.status('u-1')).status === 'done' });
  assert.equal((await w.status('u-1')).status, 'done');
  const got = new Set(w.postman.accepted.map((m) => m.to));
  for (const e of ['r5@example.com', 'r6@example.com', 'r7@example.com', 'late@example.com']) assert.equal(got.has(e), false, e);
  assert.deepEqual(await w.states('u-1'), { done: 7, 'skipped:unsubscribed': 1, 'skipped:suppressed': 2 });
  const rec = await reconcileCampaign(w.db, 'u-1', resolveConfig());
  assert.deepEqual(rec.skipped, { suppressed: 2, unsubscribed: 1 });
  assert.equal(rec.ok, true);
});

test('Queue 至少一次：每則訊息都重送一次，也沒有人收到兩封', async () => {
  const w = await makeWorld({ members: 40, config: { paceMinutes: 5 } });
  await w.campaign('d-1');
  await w.run(20, { duplicate: true, until: async () => (await w.status('d-1')).status === 'done' });
  assert.equal((await w.status('d-1')).status, 'done');
  assert.equal(w.postman.accepted.length, 40);
  assert.equal(w.maxPerAddress(), 1);
});

test('同一人被重複放水（同時兩則訊息）只寄一次；帳本已 sent 的再來只回 duplicate', async () => {
  const w = await makeWorld({ members: 3, config: { paceMinutes: 1 } });
  await w.campaign('d-2');
  await tick(w.deps);
  // 手動把同一則訊息塞兩份
  const copies = w.queue.map((m) => ({ ...m }));
  w.queue.push(...copies);
  await w.drain();
  assert.equal(w.postman.accepted.length, 3);
  // 把一位收件人硬改回 enqueued，再送一次訊息：帳本 sent → duplicate，不交郵差
  await w.db.prepare("UPDATE campaign_recipients SET state = 'enqueued' WHERE campaign_id = 'd-2' AND contact_id = 1").run();
  const r = await consume(w.deps, { kind: 'send', campaign: 'd-2', contact: 1 });
  assert.equal(r.outcome, 'duplicate');
  assert.equal(w.postman.accepted.length, 3);
});

test('派送中途 Worker 死掉（訊息全丟）：10 分鐘後重放，寄完仍是每人一封', async () => {
  const w = await makeWorld({ members: 30, config: { paceMinutes: 3 } });
  await w.campaign('k-1');
  await w.run(1); // 第一分鐘正常
  const first = w.postman.accepted.length;
  assert.ok(first > 0 && first < 30);
  await w.run(3, { dropQueue: true }); // 接下來 3 分鐘放出去的訊息全部遺失
  assert.equal(w.postman.accepted.length, first);
  assert.ok((await w.states('k-1')).enqueued > 0);
  await w.run(30, { until: async () => (await w.status('k-1')).status === 'done' });
  assert.equal((await w.status('k-1')).status, 'done');
  assert.equal(w.postman.accepted.length, 30);
  assert.equal(w.maxPerAddress(), 1);
});

test('交郵差途中斷掉（帳本 sending 已放很久）：記 uncertain、不重寄；事件回來證明寄出就自動結清', async () => {
  const w = await makeWorld({ members: 2 });
  await w.campaign('c-1');
  await tick(w.deps);
  w.queue.length = 0;
  // 模擬：第 1 位的帳本列建好了、交郵差途中 Worker 被砍（3 分鐘前）
  const old = new Date(w.clock.t - 3 * 60_000).toISOString();
  await w.db.prepare(`INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at)
    VALUES ('marketing', 'marketing', 'newsletter', 'c:c-1:1', 'newsletter', 'r0@example.com', 'news@mail.example.com', 'x', 'sending', 1, ?, ?)`).bind(old, old).run();
  const r = await consume(w.deps, { kind: 'send', campaign: 'c-1', contact: 1 });
  assert.equal(r.outcome, 'uncertain');
  assert.equal(w.postman.accepted.length, 0, '不交郵差');
  // 還沒放很久的 sending＝另一個人正在寄：稍後再問（不交郵差）
  await w.db.prepare("UPDATE campaign_recipients SET state = 'enqueued' WHERE campaign_id = 'c-1' AND contact_id = 2").run();
  await w.db.prepare(`INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at)
    VALUES ('marketing', 'marketing', 'newsletter', 'c:c-1:2', 'newsletter', 'r1@example.com', 'news@mail.example.com', 'x', 'sending', 1, ?, ?)`).bind(w.now().toISOString(), w.now().toISOString()).run();
  const r2 = await consume(w.deps, { kind: 'send', campaign: 'c-1', contact: 2 });
  assert.deepEqual(r2, { action: 'retry', delaySeconds: 60, outcome: 'in_flight' });
  assert.equal(w.postman.accepted.length, 0);
});

test('郵差丟例外（不知道寄出沒）：記 uncertain、絕不自動重寄；對帳擋下完成；人工判定後才完成', async () => {
  const w = await makeWorld({ members: 5, postman: { rules: [{ match: 'r2', outcome: 'crash' }] }, events: false });
  await w.campaign('x-1');
  await w.run(20);
  assert.equal(w.postman.calls.filter((c) => c.to === 'r2@example.com').length, 1, '只試過一次');
  const s = await w.status('x-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /^reconcile_mismatch:.*uncertain:1/);
  // 人工查證後判定「確定沒寄出」→ 失敗；續寄後對帳過、完成（失敗的不自動重寄）
  assert.equal((await resolveUncertain(w.db, 'x-1', 3, 'failed', 'provider log shows no message', w.now())).ok, true);
  assert.equal((await resumeCampaign(w.db, 'x-1', 'checked provider log', { marketingDomain: DOMAIN, now: w.now })).ok, true);
  await w.run(3);
  assert.equal((await w.status('x-1')).status, 'done');
  assert.equal(w.postman.calls.filter((c) => c.to === 'r2@example.com').length, 1);
});

test('郵差丟例外但事件證明已寄出：uncertain 自動結清成 done', async () => {
  // 第一次呼叫 crash 規則前，先讓假郵差收下並回事件，再丟例外（＝寄出了但回應丟了）
  const w = await makeWorld({ members: 3 });
  const inner = w.postman.send.bind(w.postman);
  w.postman.send = async (mail) => {
    const r = await inner(mail);
    if (mail.to === 'r1@example.com') throw new Error('connection reset after send');
    return r;
  };
  await w.campaign('x-2');
  await w.run(10, { until: async () => (await w.status('x-2')).status === 'done' });
  assert.equal((await w.status('x-2')).status, 'done');
  assert.equal(w.maxPerAddress(), 1);
  const rec = await reconcileCampaign(w.db, 'x-2', resolveConfig());
  assert.equal(rec.ok, true, rec.problems.join(','));
});

test('暫停中取消：還沒寄的記 skipped／cancelled；已經在 Queue 裡的訊息到了也不寄', async () => {
  const w = await makeWorld({ members: 20, config: { paceMinutes: 4 } });
  await w.campaign('p-1');
  await tick(w.deps); // 放出第一批，但還沒消費
  assert.ok(w.queue.length > 0);
  assert.equal((await pauseCampaign(w.db, 'p-1', 'wrong link', w.now)).ok, true);
  await w.drain(); // 暫停中：訊息到了全部退回待放水
  assert.equal(w.postman.accepted.length, 0);
  assert.equal((await w.states('p-1')).planned, 20);
  await w.run(3);
  assert.equal(w.postman.accepted.length, 0, '暫停中不放水');
  assert.deepEqual(await resumeCampaign(w.db, 'p-1', '', { marketingDomain: DOMAIN, now: w.now }), { ok: false, reason: 'note_required' });
  assert.equal((await resumeCampaign(w.db, 'p-1', 'link fixed? no, content is locked; resume anyway for test', { marketingDomain: DOMAIN, now: w.now })).ok, true);
  await tick(w.deps);
  const queued = w.queue.length;
  assert.ok(queued > 0);
  await pauseCampaign(w.db, 'p-1', 'stop', w.now);
  assert.equal((await cancelCampaign(w.db, 'p-1', 'cancel issue', w.now)).ok, true);
  await w.drain();
  assert.equal(w.postman.accepted.length, 0);
  assert.deepEqual(await w.states('p-1'), { 'skipped:cancelled': 20 });
  await w.run(2);
  assert.equal((await w.status('p-1')).status, 'cancelled');
});
