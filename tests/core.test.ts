import { test } from 'node:test';
import assert from 'node:assert/strict';
import { send, lookup, addSuppression, type SendRequest } from '../src/core.ts';
import { memoryDb, fakeFetch, type Call } from './helpers.ts';

const KEYS = { resend: 're_secret_k', smtp2go: 'api-secret-s' };
const base = (over: Partial<SendRequest> = {}): SendRequest => ({
  site: 'billing', key: 'k1', kind: 'approval_needed', from: 'Billing <billing@notify.example.com>',
  to: 'Someone@Example.com', subject: '輪到你簽', html: '<p>hi</p>', text: 'hi', ...over,
});
const quiet = async <T>(fn: () => Promise<T>) => {
  const [e, w] = [console.error, console.warn];
  console.error = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.error = e; console.warn = w; }
};

test('正常寄：走 Resend、帶 Idempotency-Key、帳本記 sent', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const r = await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) }, base());
  assert.equal(r.status, 'sent'); assert.equal(r.route, 'resend');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['idempotency-key'], 'billing/k1');
  const row = await lookup(db, 'billing', 'k1');
  assert.equal(row?.status, 'sent'); assert.equal(row?.to_email, 'someone@example.com'); assert.equal(row?.provider_id, 're_123');
  assert.equal(row?.stream, 'transactional');
});

test('同一把去重鍵：第二次不重寄，回 duplicate', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const d = { db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) };
  await send(d, base());
  const again = await send(d, base());
  assert.equal(again.status, 'duplicate'); assert.equal(again.retryable, false);
  assert.equal(calls.length, 1);
  // 別站同一把鑰匙不算重複
  assert.equal((await send(d, base({ site: 'shop' }))).status, 'sent');
});

test('Resend 4xx → 改走 SMTP2GO，帳本記 smtp2go', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const r = await quiet(() => send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({ resend: 401 }, calls) }, base()));
  assert.equal(r.route, 'smtp2go');
  assert.equal(calls.length, 2);
  assert.equal((await lookup(db, 'billing', 'k1'))?.route, 'smtp2go');
});

test('Resend 5xx：先拿同一把鑰匙補問，補問成功就不叫 SMTP2GO', async () => {
  const db = memoryDb(); const calls: Call[] = []; let n = 0;
  const r = await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({ resend: () => (n++ === 0 ? 503 : 200) }, calls) }, base());
  assert.equal(r.route, 'resend'); assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
});

test('兩個郵差都失敗：failed＋retryable；同一把鑰匙重試會再寄、attempts 累加', async () => {
  const db = memoryDb();
  const r = await quiet(() => send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({ resend: 'throw', smtp2go: 'fail' }) }, base()));
  assert.equal(r.status, 'failed'); assert.equal(r.retryable, true);
  const retry = await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}) }, base());
  assert.equal(retry.status, 'sent');
  const row = await lookup(db, 'billing', 'k1');
  assert.equal(row?.attempts, 2); assert.equal(row?.error, null);
});

test('正在寄（還沒結果）：回 in_flight 不重寄；放太久才可以重寄', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  db.raw.prepare("INSERT INTO messages (stream, site, dedupe_key, to_email, from_addr, subject, status, created_at, updated_at) VALUES ('transactional','billing','k1','a@b.example.org','x','s','sending',?,?)")
    .run(new Date().toISOString(), new Date().toISOString());
  const d = { db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) };
  assert.equal((await send(d, base())).status, 'in_flight');
  assert.equal(calls.length, 0);
  db.raw.exec("UPDATE messages SET updated_at = '2020-01-01T00:00:00.000Z'");
  assert.equal((await send(d, base())).status, 'sent');
});

test('拒收名單：硬退信、檢舉擋通知信；電子報退訂不擋通知信', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const d = { db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) };
  await addSuppression(db, 'someone@example.com', 'unsubscribe', 'manual', null);
  assert.equal((await send(d, base())).status, 'sent');
  await addSuppression(db, 'bad@example.com', 'hard_bounce', 'manual', null);
  const r = await send(d, base({ key: 'k2', to: 'BAD@example.com' }));
  assert.equal(r.status, 'suppressed'); assert.equal(r.retryable, false); assert.equal(r.reason, 'hard_bounce');
  assert.equal((await lookup(db, 'billing', 'k2'))?.status, 'suppressed');
  await addSuppression(db, 'angry@example.com', 'complaint', 'manual', null);
  assert.equal((await send(d, base({ key: 'k3', to: 'angry@example.com' }))).status, 'suppressed');
  assert.equal(calls.length, 1);
});

test('不合格的請求：rejected、不寄（寄件網域、電子報櫃台、收件人、主旨換行）', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const d = { db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) };
  for (const [over, reason] of [
    [{ from: 'x <x@example.com>' }, 'bad_from'],
    [{ from: 'x <x@evil.example.org> <a@notify.example.com>' }, 'bad_from'],
    [{ from: 'x@evil.example.org <a@notify.example.com>' }, 'bad_from'],
    [{ from: 'Billing\r\nBcc: x@y.example.org <a@notify.example.com>' }, 'bad_from'],
    [{ from: 'a@notify.example.com\r\nBcc: x@y.example.org' }, 'bad_from'],
    [{ replyTo: 'r@example.com\r\nBcc: x@y.example.org' }, 'bad_reply_to'],
    [{ stream: 'marketing' as const }, 'stream_closed'],
    [{ to: 'a@b' }, 'bad_to'],
    [{ subject: 'a\r\nBcc: x@y.example.org' }, 'bad_subject'],
    [{ site: 'Bad!' }, 'bad_site'],
    [{ key: '' }, 'bad_key'],
  ] as const) {
    const r = await send(d, base(over));
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, reason);
  }
  assert.equal(calls.length, 0);
});

test('演習 fallback：故意給錯 Resend 鑰匙 → 走 SMTP2GO', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    if (String(input).includes('resend') && h.authorization !== 'Bearer re_secret_k') return new Response('{"name":"invalid_api_Key"}', { status: 401 });
    return fakeFetch({}, calls)(input, init);
  }) as typeof fetch;
  const r = await quiet(() => send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher }, base(), { forceInvalidResend: true }));
  assert.equal(r.route, 'smtp2go');
});

test('log 不含鑰匙', async () => {
  const db = memoryDb(); const logged: string[] = [];
  const [e, w] = [console.error, console.warn];
  console.error = (...a: unknown[]) => logged.push(a.join(' ')); console.warn = (...a: unknown[]) => logged.push(a.join(' '));
  try { await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({ resend: 401, smtp2go: 'fail' }) }, base()); }
  finally { console.error = e; console.warn = w; }
  assert.ok(logged.length > 0);
  assert.ok(logged.every((l) => !l.includes('re_secret_k') && !l.includes('api-secret-s')));
});

test('寄件人重組：郵差收到的是驗過的「名稱 <地址>」，不是原字串', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) }, base({ from: '  "Billing"   <Billing@Notify.Example.com>', replyTo: 'Help <Help@Example.com>' }));
  assert.equal(calls[0].body.from, 'Billing <billing@notify.example.com>');
  assert.equal(calls[0].body.reply_to, 'Help <help@example.com>');
  assert.equal((await lookup(db, 'billing', 'k1'))?.from_addr, 'Billing <billing@notify.example.com>');
});

test('格式加嚴：主旨不准控制字元、kind 型別與長度、收件人長度', async () => {
  const db = memoryDb();
  const d = { db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}) };
  assert.equal((await send(d, base({ subject: 'a\u0007b' }))).reason, 'bad_subject');
  assert.equal((await send(d, base({ kind: { x: 1 } as unknown as string }))).reason, 'bad_kind');
  assert.equal((await send(d, base({ kind: 'k'.repeat(65) }))).reason, 'bad_kind');
  assert.equal((await send(d, base({ to: `${'a'.repeat(250)}@example.com` }))).reason, 'bad_to');
});

test('去重鍵含中文：Idempotency-Key 改成可放進 HTTP 標頭的 sha256，Resend 照常走', async () => {
  const db = memoryDb(); const calls: Call[] = [];
  const r = await send({ db, keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, calls) }, base({ key: '發票:123' }));
  assert.equal(r.status, 'sent'); assert.equal(r.route, 'resend');
  const header = calls[0].headers['idempotency-key'];
  assert.match(header, /^billing\/sha256-[0-9a-f]{64}$/);
  assert.doesNotThrow(() => new Headers({ 'idempotency-key': header }));
  // 同一把鑰匙算出同一個標頭值（補問、重試才認得）
  const again: Call[] = [];
  await send({ db: memoryDb(), keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}, again) }, base({ key: '發票:123' }));
  assert.equal(again[0].headers['idempotency-key'], header);
});

test('控制字元與文字方向控制字元：去重鍵、收件人、寄件名稱都不收', async () => {
  const d = { db: memoryDb(), keys: KEYS, fromDomain: 'notify.example.com', fetcher: fakeFetch({}) };
  assert.equal((await send(d, base({ key: 'a\nb' }))).reason, 'bad_key');
  assert.equal((await send(d, base({ to: 'a\u0000b@example.com' }))).reason, 'bad_to');
  assert.equal((await send(d, base({ to: 'a\u007f@example.com' }))).reason, 'bad_to');
  assert.equal((await send(d, base({ from: 'Bill\u202Eing <billing@notify.example.com>' }))).reason, 'bad_from');
  assert.equal((await send(d, base({ replyTo: 'Help\u2066 <help@example.com>' }))).reason, 'bad_reply_to');
  assert.equal((await send(d, base({ from: 'Bill\u061cing <billing@notify.example.com>' }))).reason, 'bad_from');
  assert.equal((await send(d, base({ kind: 'a\nb' }))).reason, 'bad_kind');
  // emoji 的連接字元（ZWJ）是合法名稱，不擋
  assert.equal((await send(d, base({ key: 'zwj', from: 'Team \u{1F468}\u200D\u{1F4BB} <billing@notify.example.com>' }))).status, 'sent');
});
