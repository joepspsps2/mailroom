// 群發：配速、每日上限跨日、限流、暫時失敗、兩級煞車、波次閘門、暖機梯子、對帳差異。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN, makeWorld } from './broadcast-helpers.ts';
import { localDay } from '../src/core.ts';
import {
  activeHold, evaluateWarmup, ingestEvent, planSteps, reconcileCampaign, releaseHold, resolveConfig, resumeCampaign, retryFailed, tick, unblockWarmup, upsertWarmupStep,
} from '../src/broadcast/index.ts';

const resume = (w: Awaited<ReturnType<typeof makeWorld>>, id: string, note = 'checked, ok to continue') => resumeCampaign(w.db, id, note, { marketingDomain: DOMAIN, now: w.now });

test('驗收：假郵差 2,300 人一期——配速 2～3 小時、每分鐘不超過速度上限的八成、全程無重複', async () => {
  const w = await makeWorld({ members: 2300, postman: { limits: { perSecond: 14, perDay: 50_000 } } });
  await w.campaign('big-1');
  const startedAt = w.clock.t;
  await w.run(240, { until: async () => (await w.status('big-1')).status === 'done' });
  assert.equal((await w.status('big-1')).status, 'done');
  const minutes = (w.clock.t - startedAt) / 60_000;
  assert.ok(minutes >= 120 && minutes <= 180, `took ${minutes} minutes`);
  assert.equal(w.postman.accepted.length, 2300);
  assert.equal(w.maxPerAddress(), 1);
  const perMinuteCap = Math.floor(14 * 60 * 0.8);
  for (const r of w.reports) for (const n of Object.values(r.released)) assert.ok(n <= perMinuteCap && n <= 16, `released ${n}`);
  assert.equal(w.count('messages', "dedupe_key LIKE 'c:big-1:%'"), 2300);
  assert.equal((await reconcileCampaign(w.db, 'big-1', resolveConfig())).ok, true);
});

test('沙盒上限（每秒 1 封、每天 200 封）：每分鐘最多 48、當天最多 200，其餘隔天再寄', async () => {
  const w = await makeWorld({ members: 260, config: { paceMinutes: 1 }, postman: { limits: { perSecond: 1, perDay: 200 } } });
  await w.campaign('sb-1');
  await w.run(10);
  for (const r of w.reports) for (const n of Object.values(r.released)) assert.ok(n <= 48, `released ${n}`);
  assert.equal(w.postman.accepted.length, 200);
  const row = await w.db.prepare('SELECT sent, "limit", paused, reason FROM throttle_days WHERE domain = ?').bind(DOMAIN).first<Record<string, unknown>>();
  assert.deepEqual({ ...row }, { sent: 200, limit: 200, paused: 1, reason: 'daily_limit' });
});

test('每日上限以台北日期換日：台北 23:59 前用完就停，台北 00:00 起新的一天（不是 UTC 午夜）', async () => {
  // 2027-03-01T15:40Z＝台北 23:40
  const w = await makeWorld({ members: 80, start: Date.parse('2027-03-01T15:40:00.000Z'), config: { maxPerDay: 30, paceMinutes: 2 }, postman: { limits: { perSecond: 50, perDay: 50_000 } } });
  await w.campaign('tz-1');
  await w.run(19); // 到台北 23:59
  assert.equal(w.postman.accepted.length, 30);
  await w.run(2); // 跨過台北午夜（UTC 16:00）
  assert.ok(w.postman.accepted.length > 30, 'new Taipei day starts sending again');
  await w.run(3000, { until: async () => (await w.status('tz-1')).status === 'done' });
  assert.equal((await w.status('tz-1')).status, 'done');
  const byDay = new Map<string, number>();
  for (const r of (await w.db.prepare("SELECT sent_at FROM messages WHERE status = 'sent'").all<{ sent_at: string }>()).results) {
    const d = localDay(new Date(r.sent_at), 8);
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  for (const [d, n] of byDay) assert.ok(n <= 30, `${d}: ${n}`);
  assert.deepEqual([...byDay.keys()].sort(), ['2027-03-01', '2027-03-02', '2027-03-03']);
  // UTC 日期會把 3-02 台北早上那段算成 3-01：確認不是照 UTC 換日
  const utcDays = new Set((await w.db.prepare("SELECT substr(sent_at, 1, 10) AS d FROM messages WHERE status = 'sent'").all<{ d: string }>()).results.map((r) => r.d));
  assert.ok(utcDays.has('2027-03-01'));
});

test('郵差回限流：那幾封 30 秒後再試、下一分鐘放量減半、最後全部寄出且無重複', async () => {
  const w = await makeWorld({ members: 30, config: { paceMinutes: 1 }, postman: { limits: { perSecond: 1, perDay: 1000 }, rules: [{ match: /./, outcome: 'throttle', times: 3 }] } });
  await w.campaign('th-1');
  await tick(w.deps);
  const firstRelease = w.reports.length ? 0 : Object.values((await tick(w.deps)).released)[0] ?? 0;
  void firstRelease;
  await w.drain();
  const t = await w.db.prepare('SELECT last_throttled_at FROM throttle_days').first<{ last_throttled_at: string | null }>();
  assert.ok(t?.last_throttled_at, 'throttle recorded');
  w.clock.t += 20_000;
  const halved = await tick(w.deps);
  const n = Object.values(halved.released)[0] ?? 0;
  assert.ok(n <= 24, `halved release ${n}`);
  await w.run(20, { until: async () => (await w.status('th-1')).status === 'done' });
  assert.equal((await w.status('th-1')).status, 'done');
  assert.equal(w.postman.accepted.length, 30);
  assert.equal(w.maxPerAddress(), 1);
});

test('暫時失敗：重試到第 3 次成功；一直失敗的記 failed、對帳算進失敗、期照樣完成；retryFailed 只在寄完前可用', async () => {
  const w = await makeWorld({
    members: 5, config: { paceMinutes: 1 },
    postman: { rules: [{ match: 'r1', outcome: 'temporary', times: 2 }, { match: 'r3', outcome: 'temporary' }, { match: 'r4', outcome: 'permanent' }] },
  });
  await w.campaign('tf-1');
  await w.run(20, { until: async () => (await w.status('tf-1')).status === 'done' });
  assert.equal((await w.status('tf-1')).status, 'done');
  assert.equal(w.postman.calls.filter((c) => c.to === 'r1@example.com').length, 3);
  assert.equal(w.postman.calls.filter((c) => c.to === 'r3@example.com').length, 3);
  assert.equal(w.postman.calls.filter((c) => c.to === 'r4@example.com').length, 1);
  const rec = await reconcileCampaign(w.db, 'tf-1', resolveConfig());
  assert.deepEqual([rec.ok, rec.sent, rec.failed], [true, 3, 2]);
  assert.deepEqual(await retryFailed(w.db, 'tf-1'), { ok: false, reason: 'illegal_state' });
});

test('🔴 寄到一半停：已寄 ≥200 且永久退信 ≥4% → 暫停；暫停後不再交郵差；續寄要寫原因、比率從續寄起算', async () => {
  // 每 20 人有 1 個 bounce@（5%）
  // 網域滾動門檻另外測（同樣 4%，會一起觸發）；這裡只看本期煞車。
  const w = await makeWorld({ members: 600, emailOf: (i) => (i % 20 === 7 ? `bounce+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 30, domainBounceRate: 1 } });
  await w.campaign('hb-1');
  await w.run(60, { until: async () => (await w.status('hb-1')).status !== 'sending' });
  const s = await w.status('hb-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /^brake:hard_bounce_rate:/);
  const sentAtPause = w.postman.accepted.length;
  assert.ok(sentAtPause >= 200 && sentAtPause < 600, `sent ${sentAtPause}`);
  assert.ok(w.alerts.some((a) => a.startsWith('red:hard_bounce_rate:hb-1')));
  await w.run(10);
  assert.equal(w.postman.accepted.length, sentAtPause, '暫停中一封都不寄');
  assert.equal((await resume(w, 'hb-1', '')).ok, false);
  assert.equal((await resume(w, 'hb-1')).ok, true);
  await w.run(5);
  assert.equal((await w.status('hb-1')).status, 'sending', '續寄後不會因為舊比率立刻又停');
  assert.ok(w.postman.accepted.length > sentAtPause);
});

test('🔴 寄到一半停：門檻上下——3.5% 不停、剛好 4% 停；寄不到 200 封不算', async () => {
  const run = async (members: number, every: number) => {
    const w = await makeWorld({ members, emailOf: (i) => (i % every === 0 ? `bounce+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 20, domainBounceRate: 1 } });
    await w.campaign('t-1');
    await w.run(200, { until: async () => (await w.status('t-1')).status !== 'sending' });
    return (await w.status('t-1')).status;
  };
  assert.equal(await run(400, 25), 'paused'); // 4%
  assert.equal(await run(400, 29), 'done'); // 約 3.5%
  assert.equal(await run(150, 5), 'done'); // 20% 但只寄 150 封
});

test('🔴 寄到一半停：檢舉 ≥3 件且 ≥0.1% → 暫停；只有 2 件不停', async () => {
  const run = async (complainers: number) => {
    const w = await makeWorld({ members: 300, emailOf: (i) => (i >= 100 && i < 100 + complainers ? `complaint+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 20, domainComplaintRate: 1 } });
    await w.campaign('cp-1');
    await w.run(200, { until: async () => (await w.status('cp-1')).status !== 'sending' });
    return w.status('cp-1');
  };
  const three = await run(3);
  assert.equal(three.status, 'paused');
  assert.match(three.pause_reason ?? '', /^brake:complaint_rate:3\//);
  assert.equal((await run(2)).status, 'done');
});

test('🔴 全面停寄：寄件網域滾動退信 ≥4% → 所有電子報停、新的一期不開寄、不能續寄；解除後重新起算', async () => {
  const w = await makeWorld({
    members: 300, emailOf: (i) => (i % 20 === 3 ? `bounce+${i}@example.com` : `r${i}@example.com`),
    config: { paceMinutes: 5, brakeHardBounceRate: 0.5, waveGateBounceRate: 1 },
  });
  await w.campaign('dh-1');
  await w.run(60, { until: async () => !!(await activeHold(w.db, DOMAIN)) });
  const hold = await activeHold(w.db, DOMAIN);
  assert.ok(hold, 'hold created');
  assert.match(hold.reason, /^bounce_rate:/);
  await w.run(1);
  assert.match((await w.status('dh-1')).pause_reason ?? '', /^brake:domain_hold:/);
  // 另一期排好了也不開寄
  await w.campaign('dh-2');
  await w.run(3);
  assert.equal((await w.status('dh-2')).status, 'scheduled');
  assert.deepEqual(await resume(w, 'dh-1'), { ok: false, reason: 'domain_held' });
  assert.ok(w.alerts.some((a) => a.startsWith('red:domain_hold')));
  // 解除（要寫原因）→ 不會因為舊資料馬上又停；暫停的期要各自續寄
  assert.deepEqual(await releaseHold(w.db, DOMAIN, ''), { ok: false, reason: 'note_required' });
  assert.equal((await releaseHold(w.db, DOMAIN, 'bad import batch removed', w.now())).ok, true);
  await w.run(2);
  assert.equal(await activeHold(w.db, DOMAIN), null);
  assert.equal((await w.status('dh-1')).status, 'paused');
  assert.equal((await w.status('dh-2')).status, 'sending');
});

test('🔴 全面停寄：滾動檢舉率 ≥0.08%；寄不到 domainMinSent 不算', async () => {
  const w = await makeWorld({ members: 2500, emailOf: (i) => (i === 500 || i === 1500 ? `complaint+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 2, brakeComplaintCount: 99 }, postman: { limits: { perSecond: 100, perDay: 100_000 } } });
  await w.campaign('dc-1');
  await w.run(120, { until: async () => !!(await activeHold(w.db, DOMAIN)) || (await w.status('dc-1')).status === 'done' });
  const hold = await activeHold(w.db, DOMAIN);
  assert.ok(hold, 'complaints ≥ 0.08% of sent');
  assert.match(hold.reason, /^complaint_rate:[12]\//);

  const small = await makeWorld({ members: 100, emailOf: (i) => (i < 10 ? `bounce+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 1 } });
  await small.campaign('ds-1');
  await small.run(20, { until: async () => (await small.status('ds-1')).status === 'done' });
  assert.equal(await activeHold(small.db, DOMAIN), null, '10% but only 100 sent');
});

test('🔴 郵差說帳號被停、或健康狀態不是 HEALTHY：暫停本期', async () => {
  const w = await makeWorld({ members: 20, config: { paceMinutes: 1 }, postman: { rules: [{ match: 'r5', outcome: 'account_paused' }] } });
  await w.campaign('ap-1');
  await w.run(5);
  assert.match((await w.status('ap-1')).pause_reason ?? '', /^brake:provider_account_paused/);
  assert.equal(w.postman.calls.filter((c) => c.to === 'r5@example.com').length, 1);

  const w2 = await makeWorld({ members: 20, config: { paceMinutes: 20, limitsRefreshMinutes: 1 } });
  await w2.campaign('en-1');
  await w2.run(2);
  w2.postman.setLimits({ enforcement: 'PROBATION' });
  await w2.run(3);
  assert.match((await w2.status('en-1')).pause_reason ?? '', /^brake:provider_enforcement:PROBATION/);
  const sent = w2.postman.accepted.length;
  await w2.run(3);
  assert.equal(w2.postman.accepted.length, sent);
});

test('Queue 壞了（交出去的都沒結果）：30 分鐘沒進度 → 暫停本期', async () => {
  const w = await makeWorld({ members: 50, config: { paceMinutes: 10 } });
  await w.campaign('qs-1');
  await w.run(45, { dropQueue: true, until: async () => (await w.status('qs-1')).status !== 'sending' });
  const s = await w.status('qs-1');
  assert.equal(s.status, 'paused');
  assert.equal(s.pause_reason, 'brake:queue_stalled');
  assert.equal(w.postman.accepted.length, 0);
});

test('分波：下一波在上一波開始 60 分鐘後才開；上一波退信 ≥2% → 下一波不開、暫停；續寄後繼續', async () => {
  const seg = (i: number) => (i < 100 ? 'core' : i < 200 ? 'steady' : 'new');
  const w = await makeWorld({ members: 300, segmentOf: seg, emailOf: (i) => (i >= 100 && i < 103 ? `bounce+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 3 } });
  await w.campaign('wv-1', { waves: [['core'], ['steady'], ['new']] });
  const t0 = w.clock.t;
  await w.run(200, { until: async () => (await w.status('wv-1')).status !== 'sending' });
  const s = await w.status('wv-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /^brake:wave_gate:wave2:3\/100/);
  const firstSteady = w.postman.accepted.findIndex((m) => Number(m.tags.contact) > 100);
  assert.ok(firstSteady >= 100, 'wave 2 starts after wave 1 is done');
  const waveStarts = JSON.parse((await w.db.prepare('SELECT counts FROM campaigns').first<{ counts: string }>())!.counts).waveStarts;
  assert.ok(Date.parse(waveStarts['2']) - t0 >= 60 * 60_000, 'wave 2 at least 60 min after wave 1 start');
  assert.equal(w.postman.accepted.filter((m) => Number(m.tags.contact) > 200).length, 0, 'wave 3 not started');
  assert.equal((await resume(w, 'wv-1', 'three dead addresses from old import, removed')).ok, true);
  await w.run(200, { until: async () => (await w.status('wv-1')).status !== 'sending' });
  assert.equal((await w.status('wv-1')).status, 'done');
  assert.equal(w.maxPerAddress(), 1);
});

test('暖機梯子：滿 72 小時、比同一批人的基準才評；過關放下一步；不過關維持；連續兩次鎖住、鎖住不開寄、解鎖後繼續', async () => {
  const seg = (i: number) => (i < 30 ? 'core' : i < 50 ? 'new' : 'sleepy');
  const w = await makeWorld({ members: 70, segmentOf: seg, config: { paceMinutes: 1, waveGapMinutes: 1, waveGateWaitMinutes: 1 } });
  await upsertWarmupStep(w.db, { plan: 'ramp', step: 1, waves: [['core'], ['new']] });
  await upsertWarmupStep(w.db, { plan: 'ramp', step: 2, waves: [['core'], ['new'], ['sleepy']] });
  const cfg = resolveConfig({});
  const opens = async (campaign: string, n: number) => {
    const ids = (await w.db.prepare("SELECT contact_id FROM campaign_recipients WHERE campaign_id = ? AND state = 'done' ORDER BY contact_id LIMIT ?").bind(campaign, n).all<{ contact_id: number }>()).results;
    for (const r of ids) await ingestEvent(w.db, { provider: 'self', providerEventId: `open-${campaign}-${r.contact_id}`, type: 'open', at: w.now().toISOString(), campaign, contact: String(r.contact_id) });
  };

  await w.campaign('ramp-1', { plan: 'ramp' });
  await w.run(60, { until: async () => (await w.status('ramp-1')).status === 'done' });
  assert.equal((await w.status('ramp-1')).status, 'done');
  assert.equal(w.postman.accepted.length, 50, 'step 1: core + new only');
  assert.deepEqual(await w.states('ramp-1'), { done: 50, 'skipped:warmup': 20 });
  await opens('ramp-1', 25); // 開信率 50%

  assert.deepEqual(await evaluateWarmup(w.db, 'ramp', 'ramp-1', 0.5, cfg, w.now), { result: 'not_ready', reasons: ['wait_72h'] });
  w.clock.t += 72 * 3_600_000;
  assert.deepEqual(await evaluateWarmup(w.db, 'ramp', 'ramp-1', undefined, cfg, w.now), { result: 'not_ready', reasons: ['baseline_missing'] });
  // 基準 0.58：50% 比基準低 8 個百分點 → 不過關，維持第 1 步
  const f1 = await evaluateWarmup(w.db, 'ramp', 'ramp-1', 0.58, cfg, w.now);
  assert.equal(f1.result, 'fail');
  assert.deepEqual(f1.result === 'fail' && [f1.reasons, f1.blocked], [['open_rate_below_baseline'], false]);
  assert.equal((await evaluateWarmup(w.db, 'ramp', 'ramp-1', 0.58, cfg, w.now)).result, 'already_evaluated', '同一期不重複計');

  await w.campaign('ramp-2', { plan: 'ramp' });
  await w.run(60, { until: async () => (await w.status('ramp-2')).status === 'done' });
  assert.equal(w.postman.accepted.filter((m) => m.tags.campaign === 'ramp-2').length, 50, 'still step 1');
  await opens('ramp-2', 20);
  w.clock.t += 73 * 3_600_000;
  const f2 = await evaluateWarmup(w.db, 'ramp', 'ramp-2', 0.5, cfg, w.now);
  assert.deepEqual(f2.result === 'fail' && [f2.fails, f2.blocked], [2, true]);

  await w.campaign('ramp-3', { plan: 'ramp' });
  await w.run(3);
  assert.equal((await w.status('ramp-3')).status, 'scheduled', 'blocked ladder: not started');
  assert.ok(w.alerts.some((a) => a.startsWith('red:start_blocked:ramp-3')));
  assert.deepEqual(await unblockWarmup(w.db, 'ramp', ''), { ok: false, reason: 'note_required' });
  assert.deepEqual(await unblockWarmup(w.db, 'ramp', 'open tracking was broken, fixed'), { ok: true, cleared: 1 });
  await w.run(60, { until: async () => (await w.status('ramp-3')).status === 'done' });
  assert.equal(w.postman.accepted.filter((m) => m.tags.campaign === 'ramp-3').length, 50, 'unblocked, still step 1');
  await opens('ramp-3', 27); // 54%：基準 0.58 − 5 個百分點＝0.53 → 過關
  w.clock.t += 72 * 3_600_000;
  const p = await evaluateWarmup(w.db, 'ramp', 'ramp-3', 0.58, cfg, w.now);
  assert.deepEqual(p.result === 'pass' && p.advancedTo, 2);
  assert.ok((await planSteps(w.db, 'ramp'))[1].released_at);

  await w.campaign('ramp-4', { plan: 'ramp' });
  await w.run(80, { until: async () => (await w.status('ramp-4')).status === 'done' });
  assert.equal(w.postman.accepted.filter((m) => m.tags.campaign === 'ramp-4').length, 70, 'step 2 adds sleepy');
});

test('暖機過關也看退信、檢舉與對帳', async () => {
  const w = await makeWorld({ members: 100, emailOf: (i) => (i < 3 ? `bounce+${i}@example.com` : i === 50 ? `complaint+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 1 } });
  await upsertWarmupStep(w.db, { plan: 'p', step: 1, waves: [['*']] });
  await upsertWarmupStep(w.db, { plan: 'p', step: 2, waves: [['*']] });
  await w.campaign('g-1', { plan: 'p' });
  await w.run(30, { until: async () => (await w.status('g-1')).status === 'done' });
  w.clock.t += 80 * 3_600_000;
  const r = await evaluateWarmup(w.db, 'p', 'g-1', 0, resolveConfig({}), w.now);
  assert.deepEqual(r.result === 'fail' && r.reasons, ['bounce_rate', 'complaint_rate']);
});

test('對帳：帳本多一封、送出事件重複、寄出的人對不到帳本 → 擋下完成（暫停）並列出差異', async () => {
  const w = await makeWorld({ members: 6, config: { paceMinutes: 6 } });
  await w.campaign('rc-1');
  await w.run(1);
  // 1. 一個被跳過的人，帳本卻有一列 sent（＝其實寄出了）
  await w.db.prepare("UPDATE campaign_recipients SET state = 'skipped', skip_reason = 'unsubscribed' WHERE campaign_id = 'rc-1' AND contact_id = 6").run();
  await w.db.prepare(`INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at, sent_at)
    VALUES ('marketing', 'marketing', 'newsletter', 'c:rc-1:6', 'newsletter', 'r5@example.com', 'news@mail.example.com', 'x', 'sent', 1, ?, ?, ?)`).bind(w.now().toISOString(), w.now().toISOString(), w.now().toISOString()).run();
  await w.run(5);
  const s = await w.status('rc-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /reconcile_mismatch:.*ledger_sent_6_vs_done_5/);
  assert.ok(w.alerts.some((a) => a.includes('reconcile_mismatch')));

  // 2. 同一人兩封不同的郵差信件 id（＝寄了兩次）
  const w2 = await makeWorld({ members: 3, config: { paceMinutes: 1 } });
  await w2.campaign('rc-2');
  await w2.run(5);
  assert.equal((await w2.status('rc-2')).status, 'done');
  await ingestEvent(w2.db, { provider: 'fake', providerEventId: 'extra-send', providerMessageId: 'fake-999', type: 'send', at: w2.now().toISOString(), campaign: 'rc-2', contact: '1' });
  const rec2 = await reconcileCampaign(w2.db, 'rc-2', resolveConfig());
  assert.equal(rec2.ok, false);
  assert.ok(rec2.problems.includes('duplicate_send_events:1'), rec2.problems.join(','));

  // 3. 寄出的人對不到帳本
  await w2.db.prepare("UPDATE campaign_recipients SET message_id = 99999 WHERE campaign_id = 'rc-2' AND contact_id = 2").run();
  const rec3 = await reconcileCampaign(w2.db, 'rc-2', resolveConfig());
  assert.ok(rec3.problems.includes('done_without_ledger:1'), rec3.problems.join(','));

  // 4. 對帳正常時：分類齊全、送達事件還沒回來不算錯
  const w3 = await makeWorld({ members: 4, config: { paceMinutes: 1 }, postman: { delays: { delivery: 3_600_000 } } });
  await w3.campaign('rc-3');
  await w3.run(5);
  const rec4 = await reconcileCampaign(w3.db, 'rc-3', resolveConfig());
  assert.equal(rec4.ok, true, rec4.problems.join(','));
  assert.equal(rec4.events.awaiting, 4);
});

// ---- 覆核找到的情境（回歸測試） ----

test('檢舉煞車沒有 200 封下限：150 人裡 3 人檢舉 → 暫停', async () => {
  const w = await makeWorld({ members: 150, emailOf: (i) => (i >= 20 && i < 23 ? `complaint+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 20, domainComplaintRate: 1 } });
  await w.campaign('cs-1');
  await w.run(100, { until: async () => (await w.status('cs-1')).status !== 'sending' });
  const s = await w.status('cs-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /^brake:complaint_rate:3\//);
});

test('郵差帳號不健康時：排好的期不開寄、一封都不交郵差；恢復健康才開寄', async () => {
  const w = await makeWorld({ members: 50, config: { paceMinutes: 1, limitsRefreshMinutes: 1 }, postman: { limits: { enforcement: 'PROBATION' } } });
  await w.campaign('uh-1');
  await w.run(3);
  assert.equal((await w.status('uh-1')).status, 'scheduled');
  assert.equal(w.postman.accepted.length, 0);
  assert.equal(w.alerts.filter((a) => a.includes('start_blocked_provider_PROBATION:uh-1')).length, 1, '同一個原因只通知一次');
  w.postman.setLimits({ enforcement: 'HEALTHY' });
  await w.run(5);
  assert.equal((await w.status('uh-1')).status, 'done');
});

test('寄送中帳號轉不健康：已在 Queue 裡的訊息到了也不交郵差', async () => {
  const w = await makeWorld({ members: 30, config: { paceMinutes: 1, limitsRefreshMinutes: 1 } });
  await w.campaign('uh-2');
  await tick(w.deps);
  w.postman.setLimits({ enforcement: 'SHUTDOWN' });
  w.clock.t += 61_000;
  await tick(w.deps); // 讀到新狀態、暫停這期
  await w.drain();
  assert.equal(w.postman.accepted.length, 0);
  assert.match((await w.status('uh-2')).pause_reason ?? '', /^brake:provider_enforcement:SHUTDOWN/);
});

test('為了無關原因暫停再續寄，分波閘門照算整波（不會拿空樣本過關）', async () => {
  const w = await makeWorld({ members: 200, segmentOf: (i) => (i < 100 ? 'core' : 'steady'), emailOf: (i) => (i < 10 ? `bounce+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 2, brakeHardBounceRate: 1, domainBounceRate: 1 } });
  await w.campaign('wg-1', { waves: [['core'], ['steady']] });
  await w.run(5); // 第一波寄完
  const { pauseCampaign } = await import('../src/broadcast/index.ts');
  assert.equal((await pauseCampaign(w.db, 'wg-1', 'routine check', w.now)).ok, true);
  assert.equal((await resume(w, 'wg-1', 'routine check done')).ok, true);
  await w.run(120, { until: async () => (await w.status('wg-1')).status !== 'sending' });
  const s = await w.status('wg-1');
  assert.equal(s.status, 'paused');
  assert.match(s.pause_reason ?? '', /^brake:wave_gate:wave1:10\/100/);
  assert.equal(w.postman.accepted.filter((m) => Number(m.tags.contact) > 100).length, 0);
});

test('分波之間停很久：放出下一波後，消費端晚一點才處理也不會被誤判成 Queue 卡住', async () => {
  const w = await makeWorld({ members: 40, segmentOf: (i) => (i < 20 ? 'core' : 'steady'), config: { paceMinutes: 1 } });
  await w.campaign('ws-1', { waves: [['core'], ['steady']] });
  await w.run(10, { until: async () => (await w.states('ws-1')).done === 20 });
  // 時間往前走、只跑 tick 不消費：等第二波放出來（上一筆進度已是 60 分鐘前）
  for (let i = 0; i < 120 && !(await w.states('ws-1')).enqueued; i++) {
    w.clock.t += 60_000;
    await tick(w.deps);
  }
  assert.ok((await w.states('ws-1')).enqueued > 0, 'wave 2 released');
  // 第二波剛放出、還沒消費：接下來幾個 tick 不能判卡住
  for (let i = 0; i < 2; i++) {
    w.clock.t += 60_000;
    await tick(w.deps);
  }
  assert.deepEqual({ ...(await w.status('ws-1')) }, { status: 'sending', pause_reason: null });
  await w.run(10, { until: async () => (await w.status('ws-1')).status === 'done' });
  assert.equal((await w.status('ws-1')).status, 'done');
});

test('對帳：凍結後名單憑空多一人 → 對不上', async () => {
  const w = await makeWorld({ members: 3, config: { paceMinutes: 1 } });
  await w.campaign('fz-1');
  await w.run(4);
  assert.equal((await w.status('fz-1')).status, 'done');
  await w.db.prepare("INSERT INTO campaign_recipients (campaign_id, contact_id, email, state, skip_reason) VALUES ('fz-1', 999, 'ghost@example.com', 'skipped', 'warmup')").run();
  const rec = await reconcileCampaign(w.db, 'fz-1', resolveConfig());
  assert.ok(rec.problems.includes('frozen_3_now_4'), rec.problems.join(','));
});

test('帳本保存天數設很短也不會清掉電子報的帳本列（至少留 400 天）', async () => {
  const { purgeLedger } = await import('../src/core.ts');
  const w = await makeWorld({ members: 2, config: { paceMinutes: 1 } });
  await w.campaign('pg-1');
  await w.run(3);
  const later = new Date(w.clock.t + 60 * 86_400_000);
  await purgeLedger(w.db, 30, later);
  assert.equal(w.count('messages', "stream = 'marketing'"), 2);
  await purgeLedger(w.db, 30, new Date(w.clock.t + 401 * 86_400_000));
  assert.equal(w.count('messages', "stream = 'marketing'"), 0);
});
