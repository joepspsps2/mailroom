// 電子報櫃台指令：每個指令的成功與失敗路徑、確認旗標（沒有 --yes 不改任何東西）、JSON 輸出、完整一期。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOMAIN, makeWorld, type World } from './broadcast-helpers.ts';
import { runCli, parseAt, type CliDefaults } from '../src/cli/main.ts';
import { handleBroadcastRequest } from '../src/broadcast/routes.ts';
import { FakePostman, upsertWarmupStep } from '../src/broadcast/index.ts';

const sample = readFileSync(new URL('./fixtures/sample-issue.md', import.meta.url), 'utf8');
const BASE = 'https://mailroom.example.com';

async function cliWorld(opts: { members?: number; config?: Record<string, unknown>; linkStatus?: number; postman?: Record<string, unknown> } = {}) {
  const w = await makeWorld({ members: opts.members ?? 30, config: { paceMinutes: 10, ...opts.config }, postman: opts.postman as never });
  const postman = new FakePostman({ now: w.now });
  const render = async (c: any) => ({ html: c.html, text: c.text, headers: { 'List-Unsubscribe': '<https://example.com/u>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  const deps = { db: w.db, domain: DOMAIN, now: w.now, config: opts.config, test: { postman, render, allowed: ['qa1@example.com', 'qa2@example.com'] } };
  const files = new Map<string, string>([['issue.md', sample]]);
  const written = new Map<string, string>();
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(BASE)) {
      const u = new URL(url);
      if (init?.headers && (init.headers as Record<string, string>).authorization !== 'Bearer secret') return new Response('not found', { status: 404 });
      const r = await handleBroadcastRequest(new Request(url, init), u, deps);
      return r ?? new Response('not found', { status: 404 });
    }
    return new Response('', { status: opts.linkStatus ?? 200 }); // 信裡連結與網頁版網址的檢查
  }) as typeof fetch;
  const defaults: CliDefaults = {
    baseUrl: BASE, list: 'weekly', from: `Weekly <news@${DOMAIN}>`, audience: { waves: [['*']] }, testRecipients: ['qa1@example.com'], subjectPrefix: '[T] ',
    template: { brandName: 'Example Weekly', lang: 'zh-Hant', greeting: '親愛的 {{name}}', footerLines: ['你收到這封信，是因為你訂閱了。'], postalAddress: '1 Example Street, Sample City 00000', labels: { viewInBrowser: '在瀏覽器開啟', unsubscribe: '取消訂閱', sentTo: '這封信寄給 {email}', embedCard: '這個內容請到網站觀看 →', image: (alt: string) => `[圖片：${alt}]` } },
    composeDefaults: { trackBase: 'https://t.example.com', siteBase: 'https://example.com' },
    webUrlFor: (fm) => (fm.slug ? `https://example.com/p/${fm.slug}` : undefined),
    previewUrl: (id) => `https://report.example.com/preview/${id}`,
    sourceFor: (post) => ({ path: `${post}.md`, ref: `posts/${post}.md@abc123`, webUrl: `https://example.com/p/${post}` }),
  };
  const run = async (args: string[], over: { token?: string; defaults?: CliDefaults } = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      defaults: over.defaults ?? defaults, env: { MAILROOM_ADMIN_TOKEN: over.token ?? 'secret' },
      io: { out: (s) => out.push(s), err: (s) => err.push(s), fetch: fetchFn, now: w.now, readFile: async (p) => { const f = files.get(p); if (f === undefined) throw new Error('nope'); return f; }, writeFile: async (p, b) => void written.set(p, b) },
    });
    return { code, out: out.join('\n'), err: err.join('\n'), json: () => JSON.parse(out[out.length - 1]) as Record<string, any> };
  };
  const state = async (id: string) => (await w.db.prepare('SELECT status, pause_reason, preflight FROM campaigns WHERE id = ?').bind(id).first<any>()) ?? null;
  /** 建好、預覽、核准的一期（用指令走一遍）。 */
  const ready = async (id: string, extra: string[] = []) => {
    assert.equal((await run(['campaign', 'create', '--issue', id, '--source', 'issue.md', '--web-url', `https://example.com/p/${id}`, '--yes', ...extra])).code, 0);
    assert.equal((await run(['campaign', 'preview', id, '--yes'])).code, 0);
    assert.equal((await run(['campaign', 'approve', id, '--note', 'owner said yes in chat', '--yes'])).code, 0);
  };
  return { w, run, state, ready, postman, files, written, defaults };
}

test('用法：沒參數、未知旗標、未知指令 → 結束碼 2；--help → 0；沒帶連線設定 → 講下一步', async () => {
  const c = await cliWorld();
  assert.equal((await c.run([])).code, 2);
  const bad = await c.run(['campaign', 'status', 'x', '--nope']);
  assert.deepEqual([bad.code, /unknown option --nope/.test(bad.err)], [2, true]);
  assert.equal((await c.run(['campaign', 'frobnicate'])).code, 2);
  assert.equal((await c.run(['--help'])).code, 0);
  assert.equal((await c.run(['campaign', 'status'])).code, 2, 'needs an id');
  const noEnv = await runCli(['campaign', 'status', 'x'], { defaults: {}, env: {}, io: { err: () => {}, out: () => {} } });
  assert.equal(noEnv, 1);
  const wrongToken = await c.run(['campaign', 'status', 'x'], { token: 'wrong' });
  assert.equal(wrongToken.code, 1);
  assert.match(wrongToken.err, /MAILROOM_ADMIN_TOKEN/);
});

test('parseAt：本地時間依時差換成 UTC；亂寫回 null', () => {
  assert.equal(parseAt('2027-03-01 09:00', '+08:00'), '2027-03-01T01:00:00.000Z');
  assert.equal(parseAt('2027-03-01T09:00:00+08:00', '+00:00'), '2027-03-01T01:00:00.000Z');
  assert.equal(parseAt('tomorrow', '+08:00'), null);
  assert.equal(parseAt('2027-13-45 99:99', '+08:00'), null);
});

test('create：沒有 --yes 只演練、什麼都不存；--yes 存草稿並記檢查；--json 只輸出一個 JSON', async () => {
  const c = await cliWorld();
  const dry = await c.run(['campaign', 'create', '--issue', 'w-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/w-1']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /DRY RUN/);
  assert.equal(await c.state('w-1'), null);
  const real = await c.run(['campaign', 'create', '--issue', 'w-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/w-1', '--yes', '--json']);
  assert.equal(real.code, 0);
  const j = real.json();
  assert.deepEqual([j.ok, j.command, j.checkOk, j.preflightOk], [true, 'create', true, true]);
  assert.equal((await c.state('w-1')).status, 'draft');
  // 網頁版網址沒給但 defaults 能從 frontmatter 推
  const viaFm = await c.run(['campaign', 'create', '--issue', 'w-2', '--source', 'issue.md', '--yes']);
  assert.equal(viaFm.code, 1, '同一份原稿（同內文）已經有 w-1：擋下');
  assert.match(viaFm.err, /duplicate_content[\s\S]*"w-1"/);
});

test('create：用 --post 找原稿；找不到檔、沒給網址、檢查沒過（連結壞、離線）都講下一步，結束碼 1 或 2', async () => {
  const c = await cliWorld();
  c.files.set('abc.md', sample);
  const post = await c.run(['campaign', 'create', '--issue', 'p-1', '--post', 'abc', '--yes']);
  assert.equal(post.code, 0);
  const row = await c.w.db.prepare('SELECT source_ref, web_url FROM campaigns WHERE id = ?').bind('p-1').first<any>();
  assert.deepEqual([row.source_ref, row.web_url], ['posts/abc.md@abc123', 'https://example.com/p/abc']);
  const missing = await c.run(['campaign', 'create', '--issue', 'p-2', '--source', 'nowhere.md', '--yes']);
  assert.deepEqual([missing.code, /Next: check the path/.test(missing.err)], [1, true]);
  const noUrl = await c.run(['campaign', 'create', '--issue', 'p-3', '--source', 'issue.md', '--yes'], { defaults: { ...c.defaults, webUrlFor: undefined } });
  assert.deepEqual([noUrl.code, /--web-url/.test(noUrl.err)], [2, true]);
  const dead = await cliWorld({ linkStatus: 404 });
  const bad = await dead.run(['campaign', 'create', '--issue', 'd-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/d-1', '--yes']);
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAILED/);
  assert.match(bad.out, /Next: fix the errors/);
  assert.equal(JSON.parse((await dead.state('d-1')).preflight).ok, false, '草稿存了，但檢查記成沒過，不能排程');
  const offline = await c.run(['campaign', 'create', '--issue', 'o-1', '--post', 'abc', '--offline', '--yes']);
  assert.equal(offline.code, 1, 'duplicate of p-1 is refused first');
  const noTpl = await c.run(['campaign', 'create', '--issue', 'n-1', '--source', 'issue.md'], { defaults: { ...c.defaults, template: undefined } });
  assert.match(noTpl.err, /No email template/);
});

test('preview：沒 --yes 不記號（不能核准）、--yes 記號；--out 寫檔；改內容後要重新預覽', async () => {
  const c = await cliWorld();
  await c.run(['campaign', 'create', '--issue', 'v-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/v-1', '--yes']);
  const dry = await c.run(['campaign', 'preview', 'v-1', '--out', 'outdir']);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /not marked as previewed/);
  assert.ok(c.written.get('outdir/email.html')?.includes('Sample Reader'));
  assert.ok(c.written.has('outdir/check.json'));
  const blocked = await c.run(['campaign', 'approve', 'v-1', '--note', 'ok', '--yes']);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /not been previewed/);
  const real = await c.run(['campaign', 'preview', 'v-1', '--yes']);
  assert.match(real.out, /report\.example\.com\/preview\/v-1/);
  assert.equal((await c.run(['campaign', 'status', 'v-1', '--json'])).json().status.previewed, true);
  assert.equal((await c.run(['campaign', 'preview', 'nope', '--yes'])).code, 1);
});

test('approve：要 --note；沒預覽或檢查沒過擋下；沒 --yes 演練；成功後狀態是 approved', async () => {
  const c = await cliWorld();
  await c.run(['campaign', 'create', '--issue', 'a-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/a-1', '--yes']);
  assert.equal((await c.run(['campaign', 'approve', 'a-1'])).code, 2, 'note required');
  await c.run(['campaign', 'preview', 'a-1', '--yes']);
  const dry = await c.run(['campaign', 'approve', 'a-1', '--note', 'owner ok']);
  assert.match(dry.out, /DRY RUN/);
  assert.equal((await c.state('a-1')).status, 'draft');
  const ok = await c.run(['campaign', 'approve', 'a-1', '--note', 'owner ok', '--yes']);
  assert.equal(ok.code, 0);
  assert.equal((await c.state('a-1')).status, 'approved');
  const again = await c.run(['campaign', 'approve', 'a-1', '--note', 'owner ok', '--yes']);
  assert.match(again.err, /approve only works on a draft/);
});

test('test：沒 --yes 只演練；白名單內寄出、白名單外被擋；沒給收件人講用法', async () => {
  const c = await cliWorld();
  await c.run(['campaign', 'create', '--issue', 't-1', '--source', 'issue.md', '--web-url', 'https://example.com/p/t-1', '--yes']);
  assert.match((await c.run(['campaign', 'test', 't-1', '--to-defaults'])).out, /DRY RUN/);
  assert.equal(c.postman.accepted.length, 0);
  const ok = await c.run(['campaign', 'test', 't-1', '--to', 'qa1@example.com,qa2@example.com', '--yes']);
  assert.equal(ok.code, 0);
  assert.equal(c.postman.accepted.length, 2);
  assert.match(c.postman.accepted[0].subject, /^\[T\] /);
  const denied = await c.run(['campaign', 'test', 't-1', '--to', 'stranger@example.com', '--yes']);
  assert.deepEqual([denied.code, /not on the test recipient list/.test(denied.err)], [1, true]);
  assert.equal((await c.run(['campaign', 'test', 't-1', '--yes'], { defaults: { ...c.defaults, testRecipients: [] } })).code, 2);
});

test('schedule／start：時間看不懂、已過去擋下；演練印這期寄給誰；--yes 排程；unschedule 退回 approved', async () => {
  const c = await cliWorld({ members: 40 });
  await upsertWarmupStep(c.w.db, { plan: 'ramp', step: 1, waves: [['core']], maxCount: 25 });
  await c.ready('s-1', ['--audience', 'ramp']);
  assert.equal((await c.run(['campaign', 'schedule', 's-1', '--at', 'whenever', '--yes'])).code, 2);
  const past = await c.run(['campaign', 'schedule', 's-1', '--at', '2020-01-01 09:00', '--yes']);
  assert.equal(past.code, 1);
  assert.match(past.err, /in the past/);
  const dry = await c.run(['campaign', 'schedule', 's-1', '--at', '2027-03-01 09:00']);
  assert.match(dry.out, /25 will receive it \(of 40 subscribed\)/);
  assert.match(dry.out, /15 not in this step/);
  assert.equal((await c.state('s-1')).status, 'approved');
  const real = await c.run(['campaign', 'schedule', 's-1', '--at', '2027-03-01 09:00', '--yes', '--json']);
  assert.equal(real.code, 0);
  assert.equal(real.json().result.scheduledAt, '2027-03-01T01:00:00.000Z');
  assert.equal((await c.state('s-1')).status, 'scheduled');
  assert.equal((await c.run(['campaign', 'unschedule', 's-1'])).code, 0);
  assert.equal((await c.state('s-1')).status, 'scheduled', 'dry-run');
  assert.equal((await c.run(['campaign', 'unschedule', 's-1', '--yes'])).code, 0);
  assert.equal((await c.state('s-1')).status, 'approved');
  assert.equal((await c.run(['campaign', 'start', 's-1'])).code, 0);
  assert.equal((await c.state('s-1')).status, 'approved', 'start without --yes only previews');
  assert.equal((await c.run(['campaign', 'start', 's-1', '--yes'])).code, 0);
  assert.equal((await c.state('s-1')).status, 'scheduled');
  const unready = await c.run(['campaign', 'schedule', 'nope', '--at', '2027-03-01 09:00']);
  assert.equal(unready.code, 1);
});

test('audience 指令與引擎實際凍結的結果一致', async () => {
  const c = await cliWorld({ members: 60 });
  await upsertWarmupStep(c.w.db, { plan: 'ramp', step: 1, waves: [['core']], maxCount: 45 });
  await c.w.db.prepare("UPDATE list_members SET segment = 'new' WHERE contact_id % 4 = 0").run();
  const { addSuppression } = await import('../src/core.ts');
  await addSuppression(c.w.db, 'r3@example.com', 'hard_bounce', 'test');
  await c.ready('au-1', ['--audience', 'ramp']);
  const a = (await c.run(['campaign', 'audience', 'au-1', '--json'])).json().audience;
  await c.run(['campaign', 'start', 'au-1', '--yes']);
  await c.w.run(2);
  const states = await c.w.states('au-1');
  const frozen = Object.values(states).reduce((x, y) => x + y, 0);
  assert.equal(frozen, a.subscribed);
  assert.equal((states['skipped:suppressed'] ?? 0), a.skipped.suppressed);
  assert.equal((states['skipped:warmup'] ?? 0), a.skipped.warmup);
  assert.equal(a.willSend, frozen - (states['skipped:suppressed'] ?? 0) - (states['skipped:warmup'] ?? 0));
});

test('完整一期：create → preview → test → approve → schedule → 寄到一半 pause → resume → done → reconcile 全對', async () => {
  const c = await cliWorld({ members: 50 });
  await c.ready('full-1');
  assert.equal((await c.run(['campaign', 'test', 'full-1', '--to-defaults', '--yes'])).code, 0);
  assert.equal((await c.run(['campaign', 'schedule', 'full-1', '--at', '2027-03-01 09:00', '--yes'])).code, 0);
  await c.w.run(10);
  assert.equal((await c.state('full-1')).status, 'sending');
  assert.ok(c.w.postman.accepted.length > 0, 'some already sent');
  const dryPause = await c.run(['campaign', 'pause', 'full-1', '--reason', 'check something']);
  assert.match(dryPause.out, /DRY RUN/);
  assert.equal((await c.state('full-1')).status, 'sending');
  assert.equal((await c.run(['campaign', 'pause', 'full-1', '--reason', 'check something', '--yes'])).code, 0);
  assert.equal((await c.state('full-1')).status, 'paused');
  const st = await c.run(['campaign', 'status', 'full-1']);
  assert.match(st.out, /RED paused/);
  assert.match(st.out, /Paused by a person/);
  assert.equal((await c.run(['campaign', 'resume', 'full-1', '--note', 'looked, fine'])).code, 0);
  assert.equal((await c.state('full-1')).status, 'paused', 'dry-run');
  assert.equal((await c.run(['campaign', 'resume', 'full-1', '--note', 'looked, fine', '--yes'])).code, 0);
  assert.equal((await c.state('full-1')).status, 'sending');
  await c.w.run(300, { until: async () => (await c.w.status('full-1')).status === 'done' });
  assert.equal((await c.state('full-1')).status, 'done');
  const rec = await c.run(['campaign', 'reconcile', 'full-1']);
  assert.equal(rec.code, 0);
  assert.match(rec.out, /all numbers add up/);
  assert.match(rec.out, /frozen 50 = sent 50/);
  assert.equal((await c.run(['campaign', 'status', 'full-1'])).out.includes('reconcile full-1'), true);
});

test('① 看原因、放行一步到位：說明哪個門檻與分子分母；網域停寄要 --release-domain；修不好的原因要 --force', async () => {
  const c = await cliWorld({ members: 300, config: { paceMinutes: 5, brakeHardBounceRate: 1, waveGateBounceRate: 1 } });
  await c.w.db.prepare("UPDATE contacts SET email = 'bounce+' || id || '@example.com' WHERE id % 20 = 3").run();
  await c.ready('rel-1');
  await c.run(['campaign', 'start', 'rel-1', '--yes']);
  const { activeHold } = await import('../src/broadcast/index.ts');
  await c.w.run(60, { until: async () => !!(await activeHold(c.w.db, DOMAIN)) });
  await c.w.run(2);
  assert.equal((await c.state('rel-1')).status, 'paused');
  const st = await c.run(['campaign', 'status', 'rel-1']);
  assert.match(st.out, /SENDER DOMAIN ON HOLD/);
  assert.match(st.out, /why: The sender domain is on hold: hard bounces \d+ of \d+/);
  assert.match(st.out, /threshold: .*"hardBounceRate":0.04/);
  assert.match(st.out, /--release-domain/);
  const noFlag = await c.run(['campaign', 'resume', 'rel-1', '--note', 'checked: old import', '--yes']);
  assert.equal(noFlag.code, 1);
  assert.match(noFlag.err, /--release-domain/);
  assert.equal((await c.state('rel-1')).status, 'paused');
  assert.ok(await activeHold(c.w.db, DOMAIN), 'still on hold');
  const dry = await c.run(['campaign', 'resume', 'rel-1', '--note', 'checked: old import', '--release-domain']);
  assert.match(dry.out, /Would release the sender-domain hold/);
  assert.ok(await activeHold(c.w.db, DOMAIN), 'dry-run did not release');
  const one = await c.run(['campaign', 'resume', 'rel-1', '--note', 'checked: old import', '--release-domain', '--yes', '--json']);
  assert.equal(one.code, 0);
  assert.equal(one.json().domainReleased, true);
  assert.equal(await activeHold(c.w.db, DOMAIN), null);
  assert.equal((await c.state('rel-1')).status, 'sending');
  // 已經不是暫停
  assert.match((await c.run(['campaign', 'resume', 'rel-1', '--note', 'x', '--yes'])).err, /not paused/);
  // 修不好的原因：不能直接放行
  await c.w.db.prepare("UPDATE campaigns SET status = 'paused', pause_reason = 'render_error:unsubscribe links not configured' WHERE id = 'rel-1'").run();
  await c.w.db.prepare('DELETE FROM domain_holds').run();
  const stuck = await c.run(['campaign', 'resume', 'rel-1', '--note', 'x', '--yes']);
  assert.equal(stuck.code, 1);
  assert.match(stuck.err, /--force/);
  assert.equal((await c.run(['campaign', 'resume', 'rel-1', '--note', 'fixed the links config', '--force', '--yes'])).code, 0);
});

test('cancel／retry-failed／resolve／hold release：沒 --yes 不動；狀態不對講清楚；成功路徑', async () => {
  const c = await cliWorld({ members: 20 });
  await c.ready('x-1');
  assert.match((await c.run(['campaign', 'cancel', 'x-1', '--reason', 'wrong issue'])).out, /DRY RUN/);
  assert.equal((await c.state('x-1')).status, 'approved');
  const retryEarly = await c.run(['campaign', 'retry-failed', 'x-1', '--yes']);
  assert.equal(retryEarly.code, 1);
  assert.match(retryEarly.err, /not in a state where this is allowed/);
  assert.equal((await c.run(['campaign', 'cancel', 'x-1', '--yes'])).code, 2, 'reason required');
  const cancelled = await c.run(['campaign', 'cancel', 'x-1', '--reason', 'wrong issue', '--yes']);
  assert.equal(cancelled.code, 0);
  assert.equal((await c.state('x-1')).status, 'cancelled');
  // retry-failed 成功：寄送中、有失敗的人
  await c.ready('x-2', ['--subject', 'second']).catch(() => {});
  assert.match((await c.run(['campaign', 'resolve', 'x-1', '--contact', 'abc', '--as', 'sent', '--note', 'n'])).err, /--contact must be a number/);
  assert.equal((await c.run(['campaign', 'resolve', 'x-1', '--contact', '1', '--as', 'sent', '--note', 'n', '--yes'])).code, 1, 'not uncertain / illegal');
  const nohold = await c.run(['campaign', 'hold', 'release', '--note', 'n', '--yes']);
  assert.equal(nohold.code, 1);
  assert.match(nohold.err, /not on hold/);
  await c.w.db.prepare("INSERT INTO domain_holds (domain, reason, created_at) VALUES (?, 'bounce_rate:9/200', ?)").bind(DOMAIN, c.w.now().toISOString()).run();
  assert.match((await c.run(['campaign', 'hold', 'release', '--note', 'checked'])).out, /DRY RUN/);
  assert.match((await c.run(['campaign', 'throttle'])).out, /DOMAIN ON HOLD/);
  assert.equal((await c.run(['campaign', 'hold', 'release', '--note', 'checked', '--yes'])).code, 0);
  assert.match((await c.run(['campaign', 'throttle'])).out, /not on hold/);
});

test('retry-failed 成功路徑：寄送中暫停後，失敗的人排回去重送', async () => {
  const c = await cliWorld({ members: 30, config: { paceMinutes: 30, maxAttempts: 1, brakeHardBounceRate: 1, domainBounceRate: 1 }, postman: { rules: [{ match: 'r5', outcome: 'permanent' }] } });
  await c.ready('rt-1');
  await c.run(['campaign', 'start', 'rt-1', '--yes']);
  await c.w.run(12);
  await c.run(['campaign', 'pause', 'rt-1', '--reason', 'look', '--yes']);
  const failed = c.w.count('campaign_recipients', "campaign_id = 'rt-1' AND state = 'failed'");
  assert.ok(failed >= 1, `failed=${failed}`);
  const dry = await c.run(['campaign', 'retry-failed', 'rt-1']);
  assert.match(dry.out, /DRY RUN/);
  assert.equal(c.w.count('campaign_recipients', "campaign_id = 'rt-1' AND state = 'failed'"), failed);
  const r = await c.run(['campaign', 'retry-failed', 'rt-1', '--yes', '--json']);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(r.json().result.requeued, failed);
});

test('retry-failed：寄完（done）之後引擎不再重送，指令照實講', async () => {
  const c = await cliWorld({ members: 10, config: { paceMinutes: 1, maxAttempts: 1 }, postman: { rules: [{ match: 'r5', outcome: 'permanent' }] } });
  await c.ready('rd-1');
  await c.run(['campaign', 'start', 'rd-1', '--yes']);
  await c.w.run(30, { until: async () => (await c.w.status('rd-1')).status === 'done' });
  const r = await c.run(['campaign', 'retry-failed', 'rd-1', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.err, /finished|done/);
});
