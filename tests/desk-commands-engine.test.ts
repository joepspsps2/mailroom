// 電子報櫃台指令對引擎的改動：可設定下限、過期不自動開寄、防重複建期、暫停原因說明、預覽與測試信、退訂告警額度。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAIN, makeWorld } from './broadcast-helpers.ts';
import { activeHold, approveCampaign, campaignStatus, explainPause, recordPreflight, resolveConfig, saveDraft, type BroadcastConfig } from '../src/broadcast/index.ts';
import { handleBroadcastRequest } from '../src/broadcast/routes.ts';
import { FakePostman } from '../src/broadcast/postman.ts';
import { parseAllowed } from '../src/broadcast/test-send.ts';
import { normalizeSesEvent } from '../src/ses-events.ts';
import { flushSuppressedAlerts, resetAlertWarning, sendAlert } from '../src/alert.ts';

const ADD = (over: Record<string, unknown> = {}) => ({ list: 'weekly', subject: 'S', from: `news@${DOMAIN}`, html: '<p>Hi {{name}} <a href="{{unsubscribe_url}}">u</a> {{web_url}}</p>', text: 'Hi {{unsubscribe_url}} {{web_url}}', headers: { 'List-Unsubscribe': '<{{unsubscribe_url}}>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }, audience: { waves: [['*']] }, ...over });

test('設定：新的下限預設不改變原規則，寫錯的值用預設', () => {
  const c = resolveConfig({});
  assert.deepEqual([c.domainMinComplaints, c.waveGateMinSent, c.startGraceMinutes], [1, 1, 360]);
  assert.equal(resolveConfig({ domainMinComplaints: 0, waveGateMinSent: -3, startGraceMinutes: 'x' as never }).domainMinComplaints, 1);
  assert.equal(resolveConfig({ domainMinComplaints: 3 }).domainMinComplaints, 3);
});

test('① 寄件網域檢舉：domainMinComplaints 調高後，2 件過線的比率不再整個網域停', async () => {
  const mk = (cfg: Partial<BroadcastConfig>) => makeWorld({ members: 2500, emailOf: (i) => (i === 500 || i === 1500 ? `complaint+${i}@example.com` : `r${i}@example.com`), config: { paceMinutes: 2, brakeComplaintCount: 99, ...cfg }, postman: { limits: { perSecond: 100, perDay: 100_000 } } });
  const strict = await mk({ domainMinComplaints: 3 });
  await strict.campaign('m-1');
  await strict.run(120, { until: async () => !!(await activeHold(strict.db, DOMAIN)) || (await strict.status('m-1')).status === 'done' });
  assert.equal(await activeHold(strict.db, DOMAIN), null, '2 complaints < 3');
  assert.equal((await strict.status('m-1')).status, 'done');
  const dflt = await mk({});
  await dflt.campaign('m-2');
  await dflt.run(120, { until: async () => !!(await activeHold(dflt.db, DOMAIN)) || (await dflt.status('m-2')).status === 'done' });
  assert.ok(await activeHold(dflt.db, DOMAIN), '預設照原規則：有 1 件且比率過線就停');
});

test('② 分波閘門樣本下限：waveGateMinSent 高於上一波寄出數 → 不判斷、不暫停', async () => {
  const mk = (cfg: Partial<BroadcastConfig>) => makeWorld({ members: 60, segmentOf: (i) => (i < 30 ? 'core' : 'steady'), emailOf: (i) => (i === 3 ? 'bounce+3@example.com' : `r${i}@example.com`), config: { paceMinutes: 2, waveGapMinutes: 1, waveGateWaitMinutes: 1, brakeHardBounceRate: 1, domainBounceRate: 1, ...cfg } });
  const loose = await mk({ waveGateMinSent: 50 });
  await loose.campaign('g-1', { waves: [['core'], ['steady']] });
  await loose.run(60, { until: async () => (await loose.status('g-1')).status !== 'sending' });
  assert.equal((await loose.status('g-1')).status, 'done', '30 sent < 50: gate does not judge');
  const strict = await mk({});
  await strict.campaign('g-2', { waves: [['core'], ['steady']] });
  await strict.run(60, { until: async () => (await strict.status('g-2')).status !== 'sending' });
  assert.match((await strict.status('g-2')).pause_reason ?? '', /^brake:wave_gate:wave1:1\/30/, '預設：1 封退信（3.3%）就停');
});

test('③ 郵差不健康很久之後恢復：過了原定時間超過 startGraceMinutes → 退回草稿、不自動開寄；寬限內照常開寄', async () => {
  const w = await makeWorld({ members: 20, config: { paceMinutes: 1, limitsRefreshMinutes: 1, startGraceMinutes: 120 }, postman: { limits: { enforcement: 'PROBATION' } } });
  await w.campaign('st-1');
  await w.run(3);
  assert.equal((await w.status('st-1')).status, 'scheduled');
  w.postman.setLimits({ enforcement: 'HEALTHY' });
  w.clock.t += 3 * 3_600_000; // 過了 3 小時才恢復
  await w.run(5);
  assert.equal((await w.status('st-1')).status, 'draft', '退回草稿：要重新核准');
  const row = await w.db.prepare('SELECT approved_hash, approved_note, counts FROM campaigns WHERE id = ?').bind('st-1').first<any>();
  assert.deepEqual([row.approved_hash, row.approved_note], [null, null]);
  assert.equal(row.counts?.includes('previewHash') ?? false, false, '預覽記號也清掉');
  assert.equal(w.postman.accepted.length, 0, '一封都沒寄');
  assert.ok(w.alerts.some((a) => a.startsWith('yellow:start_stale:st-1')));
  // 寬限內：晚 30 分鐘恢復照常開寄
  const ok = await makeWorld({ members: 20, config: { paceMinutes: 1, limitsRefreshMinutes: 1, startGraceMinutes: 120 }, postman: { limits: { enforcement: 'PROBATION' } } });
  await ok.campaign('st-2');
  await ok.run(3);
  ok.postman.setLimits({ enforcement: 'HEALTHY' });
  ok.clock.t += 30 * 60_000;
  await ok.run(40, { until: async () => (await ok.status('st-2')).status === 'done' });
  assert.equal((await ok.status('st-2')).status, 'done');
});

test('④ 同一份內容不能用不同期號建兩次（網頁版網址／原稿位置／整份內容）；取消掉的不算', async () => {
  const w = await makeWorld({ members: 1 });
  const opts = { marketingDomain: DOMAIN, now: w.now };
  assert.equal((await saveDraft(w.db, { id: 'a-1', ...ADD({ webUrl: 'https://www.example.com/p/1', sourceRef: 'posts/a.md@abc' }) }, opts)).ok, true);
  assert.deepEqual(await saveDraft(w.db, { id: 'a-2', ...ADD({ subject: 'other', webUrl: 'https://www.example.com/p/1' }) }, opts), { ok: false, reason: 'duplicate_content', twin: 'a-1', twinStatus: 'draft', twinBy: 'web_url' });
  assert.deepEqual(await saveDraft(w.db, { id: 'a-3', ...ADD({ subject: 'other', html: '<p>z</p>', text: 'z', webUrl: 'https://www.example.com/p/3', sourceRef: 'posts/a.md@abc' }) }, opts), { ok: false, reason: 'duplicate_content', twin: 'a-1', twinStatus: 'draft', twinBy: 'source_ref' });
  assert.deepEqual(await saveDraft(w.db, { id: 'a-4', ...ADD({ webUrl: 'https://www.example.com/p/4' }) }, opts), { ok: false, reason: 'duplicate_content', twin: 'a-1', twinStatus: 'draft', twinBy: 'content' }, 'same body, different url');
  // 自己改自己不算重複
  assert.equal((await saveDraft(w.db, { id: 'a-1', ...ADD({ subject: 'edited', webUrl: 'https://www.example.com/p/1', sourceRef: 'posts/a.md@abc' }) }, opts)).ok, true);
  // 取消後同一份內容可以再建
  await w.db.prepare("UPDATE campaigns SET status = 'cancelled' WHERE id = 'a-1'").run();
  assert.equal((await saveDraft(w.db, { id: 'a-5', ...ADD({ webUrl: 'https://www.example.com/p/1' }) }, opts)).ok, true);
});

test('① 看原因：暫停原因翻成門檻、分子分母與建議；網域停寄要先解除', () => {
  const cfg = resolveConfig({});
  const hb = explainPause('brake:hard_bounce_rate:9/220', cfg)!;
  assert.deepEqual([hb.code, hb.numerator, hb.denominator, hb.needsDomainRelease, hb.resumable], ['hard_bounce_rate', 9, 220, false, true]);
  assert.equal(hb.threshold?.hardBounceRate, 0.04);
  const dh = explainPause('brake:domain_hold:complaint_rate:1/220', cfg)!;
  assert.deepEqual([dh.code, dh.needsDomainRelease, dh.threshold?.minComplaints], ['domain_hold', true, 1]);
  assert.match(dh.suggestion, /single complaint/);
  assert.equal(explainPause('brake:wave_gate:wave1:1/30', cfg)!.denominator, 30);
  assert.equal(explainPause('render_error:x', cfg)!.resumable, false);
  assert.equal(explainPause('reconcile_mismatch:a', cfg)!.resumable, false);
  assert.equal(explainPause('manual: checking', cfg)!.resumable, true);
  assert.equal(explainPause(null, cfg), null);
});

// ── 路由：預覽、測試信、核准前要有預覽 ────────────────────────────────────────

async function routeWorld() {
  const w = await makeWorld({ members: 3 });
  const postman = new FakePostman({ now: w.now });
  const deps = { db: w.db, domain: DOMAIN, now: w.now, test: { postman, render: async (c: any) => ({ html: c.html, text: c.text, headers: { 'List-Unsubscribe': '<https://example.com/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } }), allowed: parseAllowed('QA1@example.com, qa2@example.com') } };
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await handleBroadcastRequest(new Request(`https://x.example.com${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`https://x.example.com${path}`), deps);
    return { status: r!.status, body: (await r!.json()) as Record<string, any> };
  };
  const opts = { marketingDomain: DOMAIN, now: w.now };
  await saveDraft(w.db, { id: 'p-1', ...ADD({ webUrl: 'https://www.example.com/p/1' }) }, opts);
  await recordPreflight(w.db, 'p-1', { ok: true, issues: [{ severity: 'info', code: 'x', message: 'fine' }] }, w.now);
  return { w, call, postman };
}

test('預覽：GET 唯讀（不記號）、POST 記號；內容只有範例收件人；核准前一定要有預覽，內容改了要重來', async () => {
  const { w, call } = await routeWorld();
  const noPreview = await call('POST', '/v1/campaigns/p-1/approve', { note: 'ok' });
  assert.deepEqual([noPreview.status, noPreview.body.reason], [409, 'preview_required']);
  const get = await call('GET', '/v1/campaigns/p-1/preview');
  assert.equal(get.status, 200);
  assert.match(get.body.html, /Sample Reader/);
  assert.match(get.body.htmlNoName, /<p>Hi\s/);
  assert.doesNotMatch(JSON.stringify(get.body), /\{\{/);
  assert.equal(get.body.preflight.issues[0].code, 'x');
  assert.equal((await call('POST', '/v1/campaigns/p-1/approve', { note: 'ok' })).body.reason, 'preview_required', 'GET 不算預覽');
  assert.equal((await call('POST', '/v1/campaigns/p-1/preview', {})).body.previewed, true);
  assert.equal((await campaignStatus(w.db, 'p-1'))!.previewed, true);
  // 內容改了：預覽失效
  await saveDraft(w.db, { id: 'p-1', ...ADD({ subject: 'S2', webUrl: 'https://www.example.com/p/1' }) }, { marketingDomain: DOMAIN, now: w.now });
  assert.equal((await call('POST', '/v1/campaigns/p-1/approve', { note: 'ok' })).body.reason, 'preview_required');
  await recordPreflight(w.db, 'p-1', { ok: true, issues: [] }, w.now);
  await call('POST', '/v1/campaigns/p-1/preview', {});
  assert.equal((await call('POST', '/v1/campaigns/p-1/approve', { note: 'ok' })).status, 200);
  assert.equal((await call('GET', '/v1/campaigns/nope/preview')).status, 404);
});

test('測試信：只寄白名單信箱、主旨加前綴、不進名單與統計；沒設白名單或網域停寄就拒絕', async () => {
  const { w, call, postman } = await routeWorld();
  const bad = await call('POST', '/v1/campaigns/p-1/test', { to: ['stranger@example.com'] });
  assert.deepEqual([bad.status, bad.body.reason], [403, 'recipient_not_allowed']);
  assert.equal(postman.accepted.length, 0);
  assert.equal((await call('POST', '/v1/campaigns/p-1/test', { to: [] })).body.reason, 'bad_recipients');
  assert.equal((await call('POST', '/v1/campaigns/p-1/test', { to: ['qa1@example.com'], subjectPrefix: 'x\ny' })).body.reason, 'bad_prefix');
  const ok = await call('POST', '/v1/campaigns/p-1/test', { to: ['qa1@example.com', 'QA2@example.com'], subjectPrefix: '[T] ' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.results.map((r: any) => r.ok), [true, true]);
  assert.equal(postman.accepted.length, 2);
  assert.equal(postman.accepted[0].subject, '[T] S');
  assert.equal(postman.accepted[0].tags.contact, 'test');
  assert.ok(postman.accepted[0].headers?.['List-Unsubscribe-Post'], '真標頭');
  assert.equal(w.count('messages'), 0, '不進帳本');
  assert.equal(w.count('campaign_recipients'), 0, '不進凍結名單');
  await w.db.prepare("INSERT INTO domain_holds (domain, reason, created_at) VALUES (?, 'x', ?)").bind(DOMAIN, w.now().toISOString()).run();
  assert.equal((await call('POST', '/v1/campaigns/p-1/test', { to: ['qa1@example.com'] })).body.reason, 'domain_held');
  const off = await handleBroadcastRequest(new Request('https://x.example.com/v1/campaigns/p-1/test', { method: 'POST', body: '{"to":["qa1@example.com"]}' }), new URL('https://x.example.com/v1/campaigns/p-1/test'), { db: w.db, domain: DOMAIN });
  assert.equal((await off!.json() as any).reason, 'test_recipients_not_configured');
});

test('測試信：郵差丟例外＝不知道有沒有寄出，照實回報、不重寄', async () => {
  const { w, call } = await routeWorld();
  const boom = { name: 'boom', send: async () => { throw new Error('socket closed'); }, limits: async () => ({ perSecond: 1, perDay: 10, enforcement: 'HEALTHY' }) };
  const r = await handleBroadcastRequest(new Request('https://x.example.com/v1/campaigns/p-1/test', { method: 'POST', body: '{"to":["qa1@example.com"]}' }), new URL('https://x.example.com/v1/campaigns/p-1/test'), { db: w.db, domain: DOMAIN, test: { postman: boom, render: w.deps.render, allowed: ['qa1@example.com'] } });
  const body = (await r!.json()) as any;
  assert.equal(body.results[0].ok, false);
  assert.match(body.results[0].error, /^unknown_outcome/);
  void call;
});

// ── ⑤ 退訂告警 ─────────────────────────────────────────────────────────────

test('⑤ 退訂告警：額度滿時寫入失敗那種照送；時間窗結束補送一則「壓掉 N 則」', async () => {
  resetAlertWarning();
  const sent: Record<string, any>[] = [];
  const fetch = (async (_u: string, init: { body: string }) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }) as never;
  const cfg = { url: 'https://alerts.example.com/h', fetch };
  let t = Date.parse('2027-03-01T01:00:00Z');
  const now = () => new Date(t);
  for (let i = 0; i < 25; i++) await sendAlert(cfg, { event: 'unsub_token_invalid', via: 'page', token: `tok${i}` }, now);
  assert.equal(sent.length, 20, '網頁類每分鐘 20 則');
  assert.equal(await sendAlert(cfg, { event: 'unsub_write_failed', via: 'page', token: 'important' }, now), true, '寫入失敗不受額度限制');
  assert.equal(sent.length, 21);
  assert.equal(await flushSuppressedAlerts(cfg, now), 0, '時間窗還沒結束，不彙總');
  t += 61_000;
  assert.equal(await flushSuppressedAlerts(cfg, now), 1);
  const summary = sent[sent.length - 1];
  assert.equal(summary.event, 'unsub_alerts_suppressed');
  assert.equal(summary.suppressed, 5);
  assert.equal(await flushSuppressedAlerts(cfg, now), 0, '只補送一次');
  // 沒有後續告警時靠排程呼叫；有後續告警進來時它自己也會先補送
  resetAlertWarning();
  sent.length = 0;
  for (let i = 0; i < 22; i++) await sendAlert(cfg, { event: 'unsub_token_invalid', via: 'page' }, now);
  t += 61_000;
  await sendAlert(cfg, { event: 'unsub_token_invalid', via: 'page' }, now);
  assert.ok(sent.some((s) => s.event === 'unsub_alerts_suppressed' && s.suppressed === 2));
});

void approveCampaign;

test('必修1：郵差上限讀不到時不開寄（留在 scheduled）；過了寬限退回草稿；恢復後不會自動全寄', async () => {
  const w = await makeWorld({ members: 20, config: { paceMinutes: 1, limitsRefreshMinutes: 1, startGraceMinutes: 120 } });
  const real = w.postman.limits.bind(w.postman);
  w.postman.limits = async () => { throw new Error('api down'); };
  await w.campaign('un-1');
  await w.run(5);
  assert.equal((await w.status('un-1')).status, 'scheduled', '讀不到上限＝不開寄、不凍結名單');
  assert.equal(w.count('campaign_recipients'), 0);
  assert.ok(w.alerts.some((a) => a.includes('start_blocked_provider_unreachable:un-1')));
  w.clock.t += 3 * 24 * 3_600_000; // 三天後才恢復
  w.postman.limits = real;
  await w.run(5);
  assert.equal((await w.status('un-1')).status, 'draft');
  assert.equal(w.postman.accepted.length, 0, '恢復後也沒有自動寄出');
});

test('必修1：已開寄但超過寬限一封都沒交出去 → 暫停 brake:start_stale；放行後重新起算、之後照常寄', async () => {
  const w = await makeWorld({ members: 10, config: { paceMinutes: 1, limitsRefreshMinutes: 1, startGraceMinutes: 30 } });
  await w.campaign('ss-1');
  await w.run(1);
  assert.equal((await w.status('ss-1')).status, 'sending');
  // 模擬開寄後什麼都沒交出去：把進度、待放水的人退回原狀
  await w.db.prepare("UPDATE campaign_recipients SET state = 'planned', enqueued_at = NULL, done_at = NULL WHERE campaign_id = 'ss-1'").run();
  await w.db.prepare("UPDATE campaigns SET last_progress_at = ? WHERE id = 'ss-1'").bind(new Date(w.clock.t - 40 * 60_000).toISOString()).run();
  w.postman.limits = async () => { throw new Error('api down'); };
  w.clock.t += 5 * 60_000;
  await w.db.prepare("UPDATE throttle_days SET refreshed_at = NULL").run();
  await w.run(2);
  const s = await w.status('ss-1');
  assert.equal(s.status, 'paused');
  assert.equal(s.pause_reason, 'brake:start_stale');
  const ex = explainPause(s.pause_reason, resolveConfig({}))!;
  assert.deepEqual([ex.code, ex.resumable], ['start_stale', true]);
});

test('建議4：permanent_streak 是設定問題，不能直接續寄', () => {
  const ex = explainPause('brake:permanent_streak:5', resolveConfig({}))!;
  assert.deepEqual([ex.code, ex.resumable], ['permanent_streak', false]);
});

test('建議5：網址正規化（斜線、大小寫、utm、片段）也算重複；寄完的舊期不擋「同原稿路徑」的新一期，但擋同網址', async () => {
  const w = await makeWorld({ members: 1 });
  const opts = { marketingDomain: DOMAIN, now: w.now };
  await saveDraft(w.db, { id: 'n-1', ...ADD({ webUrl: 'https://www.example.com/p/9', sourceRef: 'posts/latest.md' }) }, opts);
  for (const [i, u] of ['https://WWW.example.com/p/9/', 'https://www.example.com/p/9?utm_source=x#top', 'https://www.example.com/p/9//'].entries()) {
    const r = await saveDraft(w.db, { id: `n-x${i}`, ...ADD({ subject: 'other', html: `<p>${i}</p>`, text: `t${i}`, webUrl: u }) }, opts);
    assert.deepEqual([r.ok, (r as any).twinBy], [false, 'web_url'], u);
  }
  assert.equal((await saveDraft(w.db, { id: 'n-ok', ...ADD({ html: '<p>other</p>', text: 'o', webUrl: 'https://www.example.com/p/9?page=2' }) }, opts)).ok, true, '不同查詢字串是不同頁');
  await w.db.prepare("UPDATE campaigns SET status = 'done' WHERE id = 'n-1'").run();
  assert.equal((await saveDraft(w.db, { id: 'n-2', ...ADD({ html: '<p>new</p>', text: 'n', webUrl: 'https://www.example.com/p/10', sourceRef: 'posts/latest.md' }) }, opts)).ok, true, '同原稿路徑、舊期已寄完：允許');
  const same = await saveDraft(w.db, { id: 'n-3', ...ADD({ html: '<p>again</p>', text: 'a', webUrl: 'https://www.example.com/p/9' }) }, opts);
  assert.deepEqual([same.ok, (same as any).twinStatus], [false, 'done'], '同網址仍擋，並回報對方已寄完');
});

test('建議8：下限類設定設太大（等於關掉煞車）不收，回預設', () => {
  const c = resolveConfig({ domainMinComplaints: 11, waveGateMinSent: 101, startGraceMinutes: 100000 });
  assert.deepEqual([c.domainMinComplaints, c.waveGateMinSent, c.startGraceMinutes], [1, 1, 360]);
  const ok = resolveConfig({ domainMinComplaints: 10, waveGateMinSent: 100, startGraceMinutes: 2880 });
  assert.deepEqual([ok.domainMinComplaints, ok.waveGateMinSent, ok.startGraceMinutes], [10, 100, 2880]);
});

test('測試信的事件：記下，但不進拒收名單、不退訂、不算統計', async () => {
  const w = await makeWorld({ members: 3 });
  const { ingestEvent } = await import('../src/broadcast/index.ts');
  await w.campaign('te-1');
  for (const [i, type, subtype] of [[1, 'bounce', 'Permanent'], [2, 'complaint', null]] as const) {
    await ingestEvent(w.db, { provider: 'ses', providerEventId: `t-${i}`, type, subtype, at: w.now().toISOString(), email: 'qa-box@example.com', campaign: 'te-1', contact: 'test' });
  }
  assert.equal(w.count('suppressions', "email = 'qa-box@example.com'"), 0);
  assert.equal(w.count('events', "provider_event_id LIKE 't-%'"), 2);
  assert.equal(w.count('events', "contact_id IS NOT NULL AND provider_event_id LIKE 't-%'"), 0);
});

test('測試信的事件走 SES 正規化（SNS 訊息 → ProviderEvent → 入帳）：測試信箱檢舉或永久退信，不進拒收名單', async () => {
  const w = await makeWorld({ members: 3 });
  const { ingestEvent } = await import('../src/broadcast/index.ts');
  const mail = { messageId: 'ses-m-1', timestamp: '2027-03-01T00:00:00.000Z', destination: ['qa-box@example.com'], tags: { campaign: ['te-2'], contact: ['test'] } };
  const complaint = { eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'qa-box@example.com' }], complaintFeedbackType: 'abuse', timestamp: '2027-03-01T00:02:00.000Z' } };
  const bounce = { eventType: 'Bounce', mail: { ...mail, messageId: 'ses-m-2' }, bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'qa-box@example.com' }], timestamp: '2027-03-01T00:02:00.000Z' } };
  const evs = [...normalizeSesEvent(complaint, 'sns-a'), ...normalizeSesEvent(bounce, 'sns-b')];
  assert.equal(evs.length, 2);
  assert.ok(evs.every((e) => e.contact === 'test'), 'SES 正規化要保留 test 標記');
  for (const e of evs) await ingestEvent(w.db, e, { now: w.now });
  assert.equal(w.count('suppressions', "email = 'qa-box@example.com'"), 0);
  assert.equal(w.count('events', "provider = 'ses'"), 2);
  // 對照：同一個地址的「真收件人」事件（數字聯絡人）仍照常進拒收名單
  const real = normalizeSesEvent({ ...complaint, mail: { ...mail, messageId: 'ses-m-3', tags: { campaign: ['te-2'], contact: ['7'] } } }, 'sns-c');
  for (const e of real) await ingestEvent(w.db, e, { now: w.now });
  assert.equal(w.count('suppressions', "email = 'qa-box@example.com'"), 1);
});
