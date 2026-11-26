// SES 郵差：請求長相、錯誤分類（限流／帳號停／永久／不知道）、上限讀取。全部用假 fetch，不連 AWS。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySesError, encodeAddress, SesPostman } from '../src/broadcast/ses.ts';
import type { PostmanMail } from '../src/broadcast/postman.ts';

type Seen = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null };

function fetchReturning(respond: (seen: Seen) => Response | Promise<Response>, calls: Seen[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const seen: Seen = { url: String(input), method: String(init?.method), headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(seen);
    return respond(seen);
  }) as typeof fetch;
}

const err = (status: number, type: string, message = '') =>
  new Response(JSON.stringify({ message }), { status, headers: { 'x-amzn-errortype': `${type}:http://internal.amazon.com/coral/com.amazonaws.sesv2/` } });

const mail: PostmanMail = {
  from: 'Weekly Letter <news@mail.example.com>',
  to: 'reader@example.com',
  subject: '第 1 期',
  html: '<p>hi</p>',
  text: 'hi',
  replyTo: 'hello@example.com',
  headers: { 'List-Unsubscribe': '<https://u.example.com/u/tok>, <mailto:unsub@mail.example.com?subject=tok>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  tags: { campaign: 'weekly-1', contact: '42' },
  idempotencyKey: 'newsletter/c:weekly-1:42',
};

const make = (fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof SesPostman>[0]> = {}) =>
  new SesPostman({ region: 'us-east-1', credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret-example' }, configurationSet: 'newsletter-events', fetcher, now: () => new Date('2027-03-01T00:00:00Z'), ...extra });

test('送一封：SESv2 SendEmail 的網址與內文（設定組、標籤、退訂兩個標頭、UTF-8 主旨），有簽章，回 MessageId', async () => {
  const calls: Seen[] = [];
  const p = make(fetchReturning(() => new Response(JSON.stringify({ MessageId: 'ses-msg-1' }), { status: 200 }), calls));
  assert.deepEqual(await p.send(mail), { ok: true, providerId: 'ses-msg-1' });
  const c = calls[0];
  assert.equal(c.url, 'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails');
  assert.equal(c.method, 'POST');
  assert.match(c.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20270301\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(c.headers.host, undefined, 'host 交給 fetch 自己帶');
  assert.deepEqual(c.body, {
    FromEmailAddress: 'Weekly Letter <news@mail.example.com>',
    Destination: { ToAddresses: ['reader@example.com'] },
    Content: {
      Simple: {
        Subject: { Data: '第 1 期', Charset: 'UTF-8' },
        Body: { Html: { Data: '<p>hi</p>', Charset: 'UTF-8' }, Text: { Data: 'hi', Charset: 'UTF-8' } },
        Headers: [
          { Name: 'List-Unsubscribe', Value: '<https://u.example.com/u/tok>, <mailto:unsub@mail.example.com?subject=tok>' },
          { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
        ],
      },
    },
    EmailTags: [{ Name: 'campaign', Value: 'weekly-1' }, { Name: 'contact', Value: '42' }],
    ReplyToAddresses: ['hello@example.com'],
    ConfigurationSetName: 'newsletter-events',
  });
});

test('非 ASCII 的寄件人名稱用 RFC 2047 編碼；有特殊字元的 ASCII 名稱加引號', () => {
  assert.equal(encodeAddress('週報 <news@mail.example.com>'), '=?UTF-8?B?6YCx5aCx?= <news@mail.example.com>');
  assert.equal(encodeAddress('A, B <x@example.com>'), '"A, B" <x@example.com>');
  assert.equal(encodeAddress('x@example.com'), 'x@example.com');
});

test('錯誤分類：限流、每日額度、帳號停、權限、永久、5xx 不知道', async () => {
  const cases: [Response, string | 'throw'][] = [
    [err(429, 'TooManyRequestsException'), 'throttled'],
    [err(400, 'Throttling', 'Maximum sending rate exceeded.'), 'throttled'],
    [err(400, 'Throttling', 'Daily message quota exceeded.'), 'account_paused'],
    [err(400, 'AccountSuspendedException'), 'account_paused'],
    [err(400, 'SendingPausedException'), 'account_paused'],
    [err(400, 'MailFromDomainNotVerifiedException'), 'account_paused'],
    [err(404, 'NotFoundException'), 'account_paused'],
    [err(403, 'AccessDeniedException'), 'account_paused'],
    [err(403, 'SignatureDoesNotMatch'), 'account_paused'],
    [err(400, 'MessageRejected', 'Email address is not verified.'), 'permanent'],
    [err(400, 'BadRequestException'), 'permanent'],
    [err(500, 'InternalFailure'), 'throw'],
    [err(503, 'ServiceUnavailable'), 'throw'],
    [new Response('{}', { status: 200 }), 'throw'], // 200 卻沒有 MessageId：不知道
    [new Response('<html>', { status: 502 }), 'throw'],
  ];
  for (const [res, want] of cases) {
    const p = make(fetchReturning(() => res.clone()));
    if (want === 'throw') await assert.rejects(p.send(mail));
    else {
      const out = await p.send(mail);
      assert.equal(out.ok, false);
      assert.equal(!out.ok && out.kind, want, `${res.status} ${res.headers.get('x-amzn-errortype')}`);
      assert.ok(!out.ok && !out.error.includes('reader@example.com'));
    }
  }
  // 錯誤名稱也可能只在內文 __type
  const body = make(fetchReturning(() => new Response(JSON.stringify({ __type: 'com.amazonaws#TooManyRequestsException' }), { status: 400 })));
  assert.equal(((await body.send(mail)) as { kind: string }).kind, 'throttled');
  assert.equal(classifySesError(400, 'Whatever', '')?.kind, 'permanent');
  assert.equal(classifySesError(500, 'InternalFailure', ''), null);
});

test('連線錯、逾時：丟例外（引擎記 uncertain，不重寄）', async () => {
  await assert.rejects(make((async () => { throw new TypeError('fetch failed'); }) as typeof fetch).send(mail), /ses network error/);
  const slow = make(((_: unknown, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch, { timeoutMs: 20 });
  await assert.rejects(slow.send(mail), /ses timeout/);
});

test('不合格的標頭或標籤：不送出、回 permanent', async () => {
  const calls: Seen[] = [];
  const p = make(fetchReturning(() => new Response('{}'), calls));
  for (const headers of [{ 'Bad Name': 'x' }, { 'X-Ok': '中文' }, { From: 'x@example.com' }, { 'X-Ok': 'a\r\nB: c' }]) {
    assert.deepEqual(await p.send({ ...mail, headers }), { ok: false, kind: 'permanent', error: 'bad_header' });
  }
  assert.deepEqual(await p.send({ ...mail, tags: { campaign: 'weekly 1', contact: '1' } }), { ok: false, kind: 'permanent', error: 'bad_tag_campaign' });
  assert.equal(calls.length, 0);
});

test('設定錯誤直接拒絕建立（地區、鑰匙、設定組名）', () => {
  assert.throws(() => make(fetch, { region: 'https://evil.example.com' }));
  assert.throws(() => make(fetch, { credentials: { accessKeyId: '', secretAccessKey: 'x' } }));
  assert.throws(() => make(fetch, { configurationSet: 'bad name' }));
});

test('上限：GetAccount 的每秒、24 小時、已用量、健康狀態、是否離開沙盒', async () => {
  const calls: Seen[] = [];
  const sandbox = { SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 3 }, EnforcementStatus: 'HEALTHY', SendingEnabled: true, ProductionAccessEnabled: false };
  const p = make(fetchReturning(() => new Response(JSON.stringify(sandbox)), calls));
  assert.deepEqual(await p.limits(), { perSecond: 1, perDay: 200, sentLast24h: 3, enforcement: 'HEALTHY', production: false });
  assert.equal(calls[0].url, 'https://email.us-east-1.amazonaws.com/v2/email/account');
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].headers.authorization, /SignedHeaders=host;x-amz-date,/);
  const off = make(fetchReturning(() => new Response(JSON.stringify({ ...sandbox, SendingEnabled: false }))));
  assert.equal((await off.limits()).enforcement, 'SENDING_DISABLED');
  const probation = make(fetchReturning(() => new Response(JSON.stringify({ ...sandbox, EnforcementStatus: 'PROBATION' }))));
  assert.equal((await probation.limits()).enforcement, 'PROBATION');
  await assert.rejects(make(fetchReturning(() => err(403, 'AccessDeniedException'))).limits(), /GetAccount 403 AccessDeniedException/);
});
