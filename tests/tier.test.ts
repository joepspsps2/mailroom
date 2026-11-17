import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, lookup, routeFor, suppressedReason, type SendRequest, type CoreDeps } from '../src/core.ts';
import { handleCfEvent } from '../src/cf-events.ts';
import { splitAddress, type CloudflareSender } from '../src/transport.ts';
import { memoryDb, fakeFetch, type Call } from './helpers.ts';

const KEYS = { resend: 're_secret_k', smtp2go: 'api-secret-s' };
const ROUTES = { 'billing:remind': ['cloudflare', 'resend', 'smtp2go'] } as const;
const remind = (over: Partial<SendRequest> = {}): SendRequest => ({
  site: 'billing', key: 'r1', tier: 'remind', kind: 'digest', from: 'Billing <billing@remind.example.com>',
  to: 'Boss@Example.com', subject: '待你簽核：2 張', html: '<p>hi</p>', text: 'hi', ...over,
});
const quiet = async <T>(fn: () => Promise<T>) => {
  const [e, w] = [console.error, console.warn];
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};

type CfCall = Parameters<CloudflareSender['send']>[0];
function fakeCf(plan: 'ok' | 'hang' | string, calls: CfCall[] = []): CloudflareSender {
  return {
    async send(m) {
      calls.push(m);
      if (plan === 'ok') return { messageId: 'cf-msg-1' };
      if (plan === 'hang') return new Promise(() => {});
      throw Object.assign(new Error('nope'), { code: plan });
    },
  };
}

function deps(over: Partial<CoreDeps> & { cf?: CloudflareSender; calls?: Call[]; plan?: Parameters<typeof fakeFetch>[0] } = {}): CoreDeps {
  const db = over.db ?? memoryDb();
  return {
    db, keys: KEYS, fromDomain: 'notify.example.com', tierDomains: { remind: 'remind.example.com' },
    tierKeys: { remind: { ...KEYS, resend: 're_remind_k', cloudflare: over.cf } }, routes: ROUTES,
    fetcher: fakeFetch(over.plan ?? {}, over.calls ?? []),
  };
}

test('郵差順序：站:層 → *:層 → 預設；寫錯的郵差名字略過', () => {
  assert.deepEqual(routeFor(ROUTES, 'billing', 'remind'), ['cloudflare', 'resend', 'smtp2go']);
  assert.deepEqual(routeFor(ROUTES, 'billing', 'notify'), ['resend', 'smtp2go'], 'Billing 第一層不變');
  assert.deepEqual(routeFor(ROUTES, 'shop', 'remind'), ['resend', 'smtp2go'], '別站沒設＝預設');
  assert.deepEqual(routeFor({ '*:remind': ['cloudflare'] }, 'shop', 'remind'), ['cloudflare']);
  assert.deepEqual(routeFor({ 'x:remind': ['pigeon'] as never }, 'x', 'remind'), ['resend', 'smtp2go']);
  assert.deepEqual(routeFor(undefined, 'billing', 'remind'), ['resend', 'smtp2go']);
});

test('第二層：Cloudflare 先寄，帳本記 tier=remind、route=cloudflare、provider_id＝messageId', async () => {
  const cfCalls: CfCall[] = []; const calls: Call[] = [];
  const d = deps({ cf: fakeCf('ok', cfCalls), calls });
  const r = await send(d, remind());
  assert.equal(r.status, 'sent'); assert.equal(r.route, 'cloudflare');
  assert.equal(calls.length, 0, 'Resend／SMTP2GO 沒被叫');
  assert.deepEqual(cfCalls[0].from, { email: 'billing@remind.example.com', name: 'Billing' });
  assert.equal(cfCalls[0].to, 'boss@example.com');
  const row = await lookup(d.db, 'billing', 'r1');
  assert.equal(row?.tier, 'remind'); assert.equal(row?.route, 'cloudflare'); assert.equal(row?.provider_id, 'cf-msg-1');
});

test('Cloudflare 額度用完／逾時 → 改走 Resend（用第二層自己的鑰匙），寄件人不變', async () => {
  for (const plan of ['E_DAILY_LIMIT_EXCEEDED', 'E_SENDER_NOT_VERIFIED']) {
    const calls: Call[] = [];
    const r = await quiet(() => send(deps({ cf: fakeCf(plan), calls }), remind()));
    assert.equal(r.route, 'resend', plan);
    assert.equal(calls[0].headers.authorization, 'Bearer re_remind_k');
    assert.equal(calls[0].body.from, 'Billing <billing@remind.example.com>');
  }
});

test('Cloudflare 自己的拒收名單擋下：不換郵差、suppressed、不重試', async () => {
  const calls: Call[] = [];
  const d = deps({ cf: fakeCf('E_RECIPIENT_SUPPRESSED'), calls });
  const r = await send(d, remind());
  assert.equal(r.status, 'suppressed'); assert.equal(r.retryable, false); assert.equal(calls.length, 0);
  assert.equal((await lookup(d.db, 'billing', 'r1'))?.status, 'suppressed');
});

test('三個郵差都失敗：failed＋retryable', async () => {
  const r = await quiet(() => send(deps({ cf: fakeCf('E_INTERNAL_SERVER_ERROR'), plan: { resend: 401, smtp2go: 'fail' } }), remind()));
  assert.equal(r.status, 'failed'); assert.equal(r.retryable, true);
});

test('沒有 Cloudflare 綁定：直接從 Resend 開始', async () => {
  const r = await send(deps({}), remind());
  assert.equal(r.route, 'resend');
});

test('層與寄件網域要對上：第二層不准用 notify 寄、第一層不准用 remind 寄、沒開的層拒收', async () => {
  const d = deps({ cf: fakeCf('ok') });
  assert.equal((await send(d, remind({ from: 'x <billing@notify.example.com>' }))).reason, 'bad_from');
  assert.equal((await send(d, remind({ tier: 'notify', key: 'n1' }))).reason, 'bad_from');
  assert.equal((await send(d, remind({ tier: 'bulk' as never, key: 'b1' }))).reason, 'bad_tier');
  const noRemind = { ...d, tierDomains: {} };
  assert.equal((await send(noRemind, remind({ key: 'r9' }))).reason, 'bad_tier');
  // 省略 tier＝第一層（舊站照舊）
  assert.equal((await send(d, remind({ tier: undefined, key: 'n2', from: 'x <billing@notify.example.com>' }))).route, 'resend');
});

test('拒收名單兩層共用：Resend 那邊記的硬退信，第二層也擋', async () => {
  const d = deps({ cf: fakeCf('ok') });
  await d.db.prepare("INSERT INTO suppressions (email, reason, source, created_at) VALUES ('boss@example.com','hard_bounce','resend-webhook','x')").run();
  assert.equal((await send(d, remind())).status, 'suppressed');
});

test('Cloudflare 逾時 → 換 Resend（不卡住）', async () => {
  const r = await quiet(() => send(deps({ cf: fakeCf('hang') }), remind()));
  assert.equal(r.route, 'resend');
});

test('splitAddress', () => {
  assert.deepEqual(splitAddress('a@b.example.org'), { email: 'a@b.example.org' });
  assert.deepEqual(splitAddress('Billing Team <a@b.example.org>'), { email: 'a@b.example.org', name: 'Billing Team' });
});

const ev = (name: string, payload: Record<string, unknown>) => ({
  type: `cf.email.sending.message.${name}`, source: { type: 'email.sending', domain: 'remind.example.com' },
  payload: { eventId: `e-${name}`, messageId: 'cf-msg-1', recipient: 'Boss@Example.com', ...payload },
  metadata: { eventTimestamp: '2026-11-04T12:00:00Z' },
});

test('Cloudflare 事件：送達記帳、硬退信與檢舉進拒收名單、軟退信不擋、同一則只處理一次', async () => {
  const d = deps({ cf: fakeCf('ok') });
  await send(d, remind());
  assert.equal(await handleCfEvent(d.db, ev('delivered', { delivery: { status: 'delivered' } })), 'event:delivered');
  assert.equal((await lookup(d.db, 'billing', 'r1'))?.last_event, 'delivered');
  assert.equal(await handleCfEvent(d.db, ev('delivered', {})), 'repeat');
  assert.equal(await handleCfEvent(d.db, { ...ev('bounced', { bounce: { type: 'soft' } }), payload: { eventId: 'e-soft', recipient: 'x@y.example.org', bounce: { type: 'soft' } } }), 'bounce_soft');
  assert.equal(await suppressedReason(d.db, 'x@y.example.org', 'transactional'), null);
  assert.equal(await handleCfEvent(d.db, ev('bounced', { bounce: { type: 'hard', reason: 'no such user' } })), 'hard_bounce:1');
  assert.equal(await suppressedReason(d.db, 'boss@example.com', 'transactional'), 'hard_bounce');
  assert.equal(await handleCfEvent(d.db, { ...ev('complained', { complaint: { type: 'abuse' } }), payload: { eventId: 'e-c', recipient: 'Angry@X.example.org' } }), 'complaint:1');
  assert.equal(await suppressedReason(d.db, 'angry@x.example.org', 'transactional'), 'complaint');
  assert.equal(await handleCfEvent(d.db, { type: 'cf.r2.bucket.created', source: { type: 'r2' } }), 'ignored');
  assert.equal(await handleCfEvent(d.db, '{bad'), 'bad_event');
  assert.equal(await handleCfEvent(d.db, JSON.stringify(ev('rejected', { eventId: 'e-r' }))), 'event:rejected');
});

test('第二層只走 Cloudflare：失敗＝failed＋retryable；同一把鑰匙改用第一層重寄會成功，帳本改記 notify', async () => {
  const d = { ...deps({ cf: fakeCf('E_SENDER_NOT_VERIFIED') }), routes: { 'billing:remind': ['cloudflare'] } as const };
  const r = await quiet(() => send(d, remind()));
  assert.equal(r.status, 'failed'); assert.equal(r.retryable, true);
  const again = await send(d, remind({ tier: 'notify', from: 'Billing <billing@notify.example.com>' }));
  assert.equal(again.status, 'sent'); assert.equal(again.route, 'resend');
  const row = await lookup(d.db, 'billing', 'r1');
  assert.equal(row?.tier, 'notify'); assert.equal(row?.attempts, 2);
});
