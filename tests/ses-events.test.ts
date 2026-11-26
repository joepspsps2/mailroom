// SES 事件入口：SNS 簽章驗證（偽造、錯網域憑證、重放、過期憑證、SHA1）、訂閱確認、各事件正規化與退信／檢舉處理。
// 測試自己產 RSA 金鑰與一張最小的 X.509 憑證（只放解析得到的欄位），不連網。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { suppressedReason } from '../src/core.ts';
import { listSubscribe, upsertList } from '../src/lists.ts';
import { clearCertCache, handleSesWebhook, normalizeSesEvent, parseCertificate, stringToSign, type SnsMessage } from '../src/ses-events.ts';
import { count, listDb } from './lists-helpers.ts';

const REGION = 'us-east-1';
const TOPIC = 'arn:aws:sns:us-east-1:123456789012:mailroom-events';
const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123456789abcdef.pem';
const NOW = new Date('2027-03-01T00:10:00.000Z');

// ---------- 最小 DER 編碼器：只為了包出一張解析得到的憑證 ----------
function tlv(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  const len = n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff];
  return Uint8Array.from([tag, ...len, ...body]);
}
const seq = (...parts: Uint8Array[]) => tlv(0x30, Uint8Array.from(parts.flatMap((p) => [...p])));
const ascii = (s: string) => new TextEncoder().encode(s);

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });

/** X.509 的兩種時間格式：UTCTime（兩位數年）與 GeneralizedTime（四位數年）。 */
const asn1Utc = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z';
const asn1Gen = (d: Date) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
const day = (s: string) => new Date(`${s}T00:00:00Z`);

function pem(spki: Buffer, notBefore = asn1Utc(day('2026-01-01')), notAfter = asn1Gen(day('2099-12-31'))): string {
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Uint8Array.from([2]))),
    tlv(0x02, Uint8Array.from([1])),
    seq(),
    seq(),
    seq(tlv(0x17, ascii(notBefore)), tlv(notAfter.length === 15 ? 0x18 : 0x17, ascii(notAfter))),
    seq(),
    Uint8Array.from(spki),
  );
  const der = seq(tbs, seq(), tlv(0x03, Uint8Array.from([0, 1, 2, 3])));
  return `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString('base64').replace(/(.{64})/g, '$1\n')}\n-----END CERTIFICATE-----\n`;
}
const GOOD_PEM = pem(publicKey.export({ type: 'spki', format: 'der' }));

function signed(fields: Partial<SnsMessage> & { Type: string; Message: string }, opts: { version?: '1' | '2'; key?: typeof privateKey } = {}): SnsMessage {
  const msg = {
    MessageId: `sns-${Math.random().toString(36).slice(2)}`,
    TopicArn: TOPIC,
    Timestamp: '2027-03-01T00:09:00.000Z',
    SignatureVersion: opts.version ?? '2',
    SigningCertURL: CERT_URL,
    Signature: '',
    ...fields,
  } as SnsMessage;
  const s = createSign(msg.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256');
  s.update(stringToSign(msg)!);
  msg.Signature = s.sign(opts.key ?? privateKey, 'base64');
  return msg;
}

interface Net { calls: string[]; certPem: string }
function network(net: Net): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    net.calls.push(url);
    if (url.endsWith('.pem')) return new Response(net.certPem, { status: 200 });
    if (url.includes('Action=ConfirmSubscription')) return new Response('<ConfirmSubscriptionResponse/>', { status: 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
}

function setupNet() {
  const net: Net = { calls: [], certPem: GOOD_PEM };
  const opts = { region: REGION, topicArns: [TOPIC], fetcher: network(net), now: () => NOW };
  return { net, opts };
}

async function world() {
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly' });
  await upsertList(db, { id: 'promo', name: 'Promo' });
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) await listSubscribe(db, { list: 'weekly', email: e });
  await listSubscribe(db, { list: 'promo', email: 'a@example.com' });
  return db;
}

function sesEvent(eventType: string, to: string, body: Record<string, unknown>, extra: { campaign?: string; contact?: string; destination?: string[]; messageId?: string } = {}) {
  return JSON.stringify({
    eventType,
    mail: {
      timestamp: '2027-03-01T00:00:00.000Z',
      messageId: extra.messageId ?? `ses-${to}`,
      destination: extra.destination ?? [to],
      tags: { 'ses:configuration-set': ['newsletter-events'], campaign: [extra.campaign ?? 'weekly-1'], contact: [extra.contact ?? '1'] },
    },
    ...body,
  });
}
const bounce = (to: string, bounceType: string, bounceSubType: string, extra = {}) =>
  sesEvent('Bounce', to, { bounce: { bounceType, bounceSubType, bouncedRecipients: [{ emailAddress: to, status: '5.1.1', diagnosticCode: 'smtp; 550' }], timestamp: '2027-03-01T00:01:00.000Z', feedbackId: 'fb-1' } }, extra);
const complaint = (to: string, type = 'abuse') => sesEvent('Complaint', to, { complaint: { complainedRecipients: [{ emailAddress: to }], complaintFeedbackType: type, timestamp: '2027-03-01T00:02:00.000Z', feedbackId: 'fb-2' } });

const post = (db: ReturnType<typeof listDb>, msg: unknown, opts: Parameters<typeof handleSesWebhook>[2]) => handleSesWebhook(db, JSON.stringify(msg), opts);
const member = (db: ReturnType<typeof listDb>, list: string, email: string) =>
  (db.raw.prepare('SELECT m.status, m.unsub_source FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?').get(list, email) as { status: string; unsub_source: string | null });

beforeEach(() => clearCertCache());

test('憑證解析：取得公鑰與有效期間（UTCTime 與 GeneralizedTime）', () => {
  const c = parseCertificate(GOOD_PEM);
  assert.equal(c.notBefore, Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(c.notAfter, Date.parse('2099-12-31T00:00:00Z'));
  assert.deepEqual(Buffer.from(c.spki), publicKey.export({ type: 'spki', format: 'der' }));
  assert.throws(() => parseCertificate('not a cert'));
});

test('永久退信：簽章對 → 進全域拒收 hard_bounce、事件表一列（SES 訊息編號）、重送只處理一次', async () => {
  const db = await world();
  const { net, opts } = setupNet();
  const msg = signed({ Type: 'Notification', Message: bounce('a@example.com', 'Permanent', 'NoEmail') });
  assert.deepEqual(await post(db, msg, opts), { status: 200, outcome: 'bounce:recorded' });
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), 'hard_bounce');
  const ev = db.raw.prepare('SELECT provider, provider_message_id, campaign_id, contact_id, type, subtype FROM events').all();
  assert.deepEqual(ev.map((r) => ({ ...r })), [{ provider: 'ses', provider_message_id: 'ses-a@example.com', campaign_id: 'weekly-1', contact_id: 1, type: 'bounce', subtype: 'Permanent' }]);
  assert.equal(count(db, 'webhook_events', `id = 'ses:${msg.MessageId}'`), 1);
  assert.deepEqual(await post(db, msg, opts), { status: 200, outcome: 'repeat' });
  assert.equal(count(db, 'events'), 1);
  assert.equal(net.calls.filter((u) => u.endsWith('.pem')).length, 1, '憑證有快取');
});

test('偽造：內容被改、別把鑰匙簽的、簽章亂碼 → 403，什麼都不寫', async () => {
  const db = await world();
  const { opts } = setupNet();
  const tampered = signed({ Type: 'Notification', Message: bounce('a@example.com', 'Transient', 'MailboxFull') });
  tampered.Message = bounce('a@example.com', 'Permanent', 'General');
  assert.deepEqual(await post(db, tampered, opts), { status: 403, outcome: 'rejected:bad_signature' });
  const wrongKey = signed({ Type: 'Notification', Message: complaint('a@example.com') }, { key: other.privateKey });
  assert.equal((await post(db, wrongKey, opts)).outcome, 'rejected:bad_signature');
  const garbage = { ...signed({ Type: 'Notification', Message: complaint('a@example.com') }), Signature: 'AAAA' };
  assert.equal((await post(db, garbage, opts)).status, 403);
  // Subject 偷加進去（待簽字串會變）
  const withSubject = { ...signed({ Type: 'Notification', Message: complaint('b@example.com') }), Subject: 'x' };
  assert.equal((await post(db, withSubject, opts)).outcome, 'rejected:bad_signature');
  assert.equal(count(db, 'suppressions'), 0);
  assert.equal(count(db, 'events'), 0);
});

test('憑證網址不是該地區的 SNS 主機 → 403，而且不去抓那個網址', async () => {
  const db = await world();
  const { net, opts } = setupNet();
  const bad = [
    'https://sns.us-east-1.amazonaws.com.evil.example.com/SimpleNotificationService-0123.pem',
    'https://evil.example.com/SimpleNotificationService-0123.pem',
    'http://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem',
    'https://sns.us-west-2.amazonaws.com/SimpleNotificationService-0123.pem',
    'https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-0123.pem',
    Object.assign(new URL('https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem'), { username: 'user' }).toString(),
    'https://sns.us-east-1.amazonaws.com/other/key.pem',
    'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0123.pem?x=1',
  ];
  for (const url of bad) {
    const msg = signed({ Type: 'Notification', Message: complaint('a@example.com'), SigningCertURL: url });
    assert.deepEqual(await post(db, msg, opts), { status: 403, outcome: 'rejected:untrusted_cert_url' }, url);
  }
  assert.equal(net.calls.length, 0);
  assert.equal(count(db, 'suppressions'), 0);
});

test('主題不在白名單、主題地區不對 → 403', async () => {
  const db = await world();
  const { opts } = setupNet();
  const other = signed({ Type: 'Notification', Message: complaint('a@example.com'), TopicArn: 'arn:aws:sns:us-east-1:999999999999:mailroom-events' });
  assert.equal((await post(db, other, opts)).outcome, 'rejected:topic_not_allowed');
  const none = signed({ Type: 'Notification', Message: complaint('a@example.com') });
  assert.equal((await post(db, none, { ...opts, topicArns: [] })).outcome, 'rejected:topic_not_allowed');
  const regionTopic = 'arn:aws:sns:us-west-2:123456789012:mailroom-events';
  assert.equal((await post(db, signed({ Type: 'Notification', Message: complaint('a@example.com'), TopicArn: regionTopic }), { ...opts, topicArns: [regionTopic] })).outcome, 'rejected:topic_not_allowed');
});

test('重放：太舊（超過 7 天）或未來太遠的訊息不收；7 天內的重放靠去重', async () => {
  const db = await world();
  const { opts } = setupNet();
  const old = signed({ Type: 'Notification', Message: complaint('a@example.com'), Timestamp: '2027-02-20T00:00:00.000Z' });
  assert.equal((await post(db, old, opts)).outcome, 'rejected:stale_timestamp');
  const future = signed({ Type: 'Notification', Message: complaint('a@example.com'), Timestamp: '2027-03-01T01:00:00.000Z' });
  assert.equal((await post(db, future, opts)).outcome, 'rejected:stale_timestamp');
  const fresh = signed({ Type: 'Notification', Message: complaint('a@example.com') });
  assert.equal((await post(db, fresh, opts)).status, 200);
  assert.equal((await post(db, fresh, opts)).outcome, 'repeat');
});

test('SignatureVersion 1（SHA1）預設不收；部署端打開才收', async () => {
  const db = await world();
  const { opts } = setupNet();
  const v1 = signed({ Type: 'Notification', Message: complaint('a@example.com') }, { version: '1' });
  assert.equal((await post(db, v1, opts)).outcome, 'rejected:signature_version_not_allowed');
  assert.equal((await post(db, v1, { ...opts, allowSha1: true })).status, 200);
  const v3 = { ...v1, SignatureVersion: '3' };
  assert.equal((await post(db, v3, { ...opts, allowSha1: true })).outcome, 'rejected:signature_version_not_allowed');
});

test('憑證過期或還沒生效 → 403', async () => {
  const db = await world();
  const { net, opts } = setupNet();
  net.certPem = pem(publicKey.export({ type: 'spki', format: 'der' }), asn1Utc(day('2020-01-01')), asn1Utc(day('2021-01-01')));
  assert.equal((await post(db, signed({ Type: 'Notification', Message: complaint('a@example.com') }), opts)).outcome, 'rejected:cert_expired');
  clearCertCache();
  net.certPem = pem(publicKey.export({ type: 'spki', format: 'der' }), asn1Utc(day('2030-01-01')), asn1Gen(day('2099-12-31')));
  assert.equal((await post(db, signed({ Type: 'Notification', Message: complaint('a@example.com') }), opts)).outcome, 'rejected:cert_expired');
});

test('訂閱確認：驗過簽章、SubscribeURL 是同一個 SNS 主機與主題，才去確認；別的網址一律不打', async () => {
  const db = await world();
  const { net, opts } = setupNet();
  const good = `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(TOPIC)}&Token=tok-example`;
  const ok = signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: good, Token: 'tok-example' });
  assert.deepEqual(await post(db, ok, opts), { status: 200, outcome: 'subscription_confirmed' });
  assert.ok(net.calls.includes(good));
  for (const url of ['https://evil.example.com/?Action=ConfirmSubscription', `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent('arn:aws:sns:us-east-1:1:other')}&Token=t`, 'https://sns.us-east-1.amazonaws.com/?Action=Publish&Token=t']) {
    net.calls.length = 0;
    const m = signed({ Type: 'SubscriptionConfirmation', Message: 'confirm', SubscribeURL: url, Token: 'tok-example' });
    assert.equal((await post(db, m, opts)).outcome, 'rejected:untrusted_subscribe_url');
    assert.deepEqual(net.calls.filter((u) => !u.endsWith('.pem')), []);
  }
  // 簽章壞掉的訂閱確認：不打 SubscribeURL
  net.calls.length = 0;
  const forged = { ...ok, Token: 'other' };
  assert.equal((await post(db, forged, opts)).status, 403);
  assert.deepEqual(net.calls.filter((u) => !u.endsWith('.pem')), []);
  assert.equal((await post(db, signed({ Type: 'UnsubscribeConfirmation', Message: 'bye', SubscribeURL: good, Token: 't' }), opts)).outcome, 'unsubscribe_confirmation_ignored');
});

test('HTTP 標頭的訊息類型跟內文不一致 → 400；內文不是 JSON → 400', async () => {
  const db = await world();
  const { opts } = setupNet();
  const msg = signed({ Type: 'Notification', Message: complaint('a@example.com') });
  assert.equal((await handleSesWebhook(db, JSON.stringify(msg), opts, 'SubscriptionConfirmation')).status, 400);
  assert.equal((await handleSesWebhook(db, '{', opts)).status, 400);
});

test('檢舉 → 全域拒收 complaint＋所有名單退出；「不是垃圾信」不算檢舉', async () => {
  const db = await world();
  const { opts } = setupNet();
  assert.equal((await post(db, signed({ Type: 'Notification', Message: complaint('a@example.com') }), opts)).outcome, 'complaint:recorded');
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), 'complaint');
  assert.deepEqual({ ...member(db, 'weekly', 'a@example.com') }, { status: 'unsubscribed', unsub_source: 'complaint' });
  assert.deepEqual({ ...member(db, 'promo', 'a@example.com') }, { status: 'unsubscribed', unsub_source: 'complaint' });
  assert.equal((await post(db, signed({ Type: 'Notification', Message: complaint('b@example.com', 'not-spam') }), opts)).outcome, 'ignored:Complaint');
  assert.equal(await suppressedReason(db, 'b@example.com', 'marketing'), null);
  assert.equal(member(db, 'weekly', 'b@example.com').status, 'subscribed');
});

test('暫時退信：只有信箱滿（MailboxFull）連續 3 期才升級成硬退信；一般性、內容被拒、無法判定都不累計', async () => {
  const db = await world();
  const { opts } = setupNet();
  const send = (to: string, type: string, sub: string, campaign: string) => post(db, signed({ Type: 'Notification', Message: bounce(to, type, sub, { campaign, messageId: `${to}-${campaign}` }) }), opts);
  for (const c of ['weekly-1', 'weekly-2', 'weekly-3', 'weekly-4']) {
    await send('b@example.com', 'Transient', 'General', c);
    await send('c@example.com', 'Transient', 'ContentRejected', c);
    await send('a@example.com', 'Undetermined', 'Undetermined', c);
  }
  for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) assert.equal(await suppressedReason(db, e, 'transactional'), null, e);
  assert.equal(count(db, 'bounce_streaks'), 0);
  await send('b@example.com', 'Transient', 'MailboxFull', 'weekly-5');
  await send('b@example.com', 'Transient', 'MailboxFull', 'weekly-6');
  assert.equal(await suppressedReason(db, 'b@example.com', 'marketing'), null);
  await send('b@example.com', 'Transient', 'MailboxFull', 'weekly-7');
  assert.equal(await suppressedReason(db, 'b@example.com', 'transactional'), 'hard_bounce');
});

test('送達會中斷「連續暫時退信」', async () => {
  const db = await world();
  const { opts } = setupNet();
  const go = (body: string) => post(db, signed({ Type: 'Notification', Message: body }), opts);
  await go(bounce('a@example.com', 'Transient', 'MailboxFull', { campaign: 'w-1', messageId: 'm1' }));
  await go(bounce('a@example.com', 'Transient', 'MailboxFull', { campaign: 'w-2', messageId: 'm2' }));
  await go(sesEvent('Delivery', 'a@example.com', { delivery: { recipients: ['a@example.com'], timestamp: '2027-03-01T00:03:00.000Z' } }, { campaign: 'w-3', messageId: 'm3' }));
  await go(bounce('a@example.com', 'Transient', 'MailboxFull', { campaign: 'w-4', messageId: 'm4' }));
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), null);
});

test('正規化：每種事件 → 對的型別；收件人只認原信收件人（列了別的地址不認；沒列地址且單一收件人才算他）', () => {
  const n = (body: string) => normalizeSesEvent(JSON.parse(body), 'sns-1');
  assert.deepEqual(n(sesEvent('Send', 'a@example.com', { send: {} })).map((e) => [e.type, e.email, e.campaign, e.contact]), [['send', 'a@example.com', 'weekly-1', '1']]);
  assert.equal(n(sesEvent('Reject', 'a@example.com', { reject: { reason: 'Bad content' } }))[0].type, 'reject');
  assert.deepEqual(n(sesEvent('Rendering Failure', 'a@example.com', { failure: { errorMessage: 'x' } })).map((e) => [e.type, e.subtype]), [['reject', 'RenderingFailure']]);
  assert.deepEqual(n(sesEvent('DeliveryDelay', 'a@example.com', { deliveryDelay: { delayType: 'MailboxFull', delayedRecipients: [{ emailAddress: 'a@example.com' }] } })).map((e) => [e.type, e.subtype]), [['delay', 'MailboxFull']]);
  assert.deepEqual(n(sesEvent('Open', 'a@example.com', { open: {} })), []);
  assert.deepEqual(n(sesEvent('Click', 'a@example.com', { click: {} })), []);
  // 轉寄目的地退信：事件列的是別的地址 → 不認（不能把讀者封鎖）
  const fwd = sesEvent('Bounce', 'a@example.com', { bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'forward@example.org' }] } });
  assert.deepEqual(n(fwd), []);
  // 事件完全沒列收件人、原信只有一位 → 算他
  const unlisted = sesEvent('Delivery', 'a@example.com', { delivery: { recipients: [] } });
  assert.deepEqual(n(unlisted).map((e) => e.email), ['a@example.com']);
  const multi = sesEvent('Bounce', 'a@example.com', { bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'forward@example.org' }] } }, { destination: ['a@example.com', 'b@example.com'] });
  assert.deepEqual(n(multi), []);
  // 子類型 → cause
  const sub = (s: string, t = 'Transient') => n(bounce('a@example.com', t, s))[0];
  assert.equal(sub('MailboxFull').cause, 'mailbox');
  assert.equal(sub('MessageTooLarge').cause, 'content');
  assert.equal(sub('AttachmentRejected').cause, 'content');
  assert.equal(sub('General').cause, undefined);
  assert.equal(sub('CustomTimeoutExceeded').cause, undefined);
  assert.equal(sub('Undetermined', 'Undetermined').subtype, 'Undetermined');
  assert.equal(sub('OnAccountSuppressionList', 'Permanent').subtype, 'Permanent');
  // 沒有 mail.messageId、不是物件 → 不認
  assert.deepEqual(normalizeSesEvent({ eventType: 'Bounce' }, 'x'), []);
  assert.deepEqual(normalizeSesEvent('nope', 'x'), []);
});

test('別的設定組的事件不處理（同一個帳號或主題的其他寄信不影響拒收名單）', async () => {
  const db = await world();
  const { opts } = setupNet();
  const o = { ...opts, configurationSet: 'mailroom-events' };
  const foreign = signed({ Type: 'Notification', Message: complaint('a@example.com') }); // tag 是 newsletter-events
  assert.equal((await post(db, foreign, o)).outcome, 'ignored:Complaint');
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), null);
  const ours = signed({ Type: 'Notification', Message: complaint('a@example.com') });
  assert.equal((await post(db, ours, { ...o, configurationSet: 'newsletter-events' })).outcome, 'complaint:recorded');
});

test('SES 因帳號層級拒收名單根本沒寄（OnAccountSuppressionList）：只記事件，不重新封鎖、不退訂', async () => {
  const db = await world();
  const { opts } = setupNet();
  assert.equal((await post(db, signed({ Type: 'Notification', Message: bounce('a@example.com', 'Permanent', 'OnAccountSuppressionList') }), opts)).outcome, 'bounce:recorded');
  const c = sesEvent('Complaint', 'b@example.com', { complaint: { complainedRecipients: [{ emailAddress: 'b@example.com' }], complaintSubType: 'OnAccountSuppressionList' } });
  assert.equal((await post(db, signed({ Type: 'Notification', Message: c }), opts)).outcome, 'complaint:recorded');
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), null);
  assert.equal(await suppressedReason(db, 'b@example.com', 'transactional'), null);
  assert.equal(member(db, 'weekly', 'b@example.com').status, 'subscribed');
  assert.equal(count(db, 'events'), 2);
});

test('帳本列的收件人跟事件地址不同：不把事件算到那位讀者（用標籤對到的列也一樣）', async () => {
  const { ingestEvent } = await import('../src/broadcast/events.ts');
  const db = await world();
  db.raw.prepare("INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at, provider_id) VALUES ('marketing','marketing','newsletter','c:weekly-1:1','newsletter','a@example.com','n@mail.example.com','s','sent',1,'x','x','ses-x')").run();
  await ingestEvent(db, { provider: 'ses', providerEventId: 'e-1', providerMessageId: 'other-id', type: 'complaint', at: '2027-03-01T00:00:00Z', email: 'stranger@example.org', campaign: 'weekly-1', contact: '1' });
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), null);
  assert.equal(await suppressedReason(db, 'stranger@example.org', 'transactional'), 'complaint');
  const ev = db.raw.prepare("SELECT message_id, campaign_id FROM events WHERE provider_event_id = 'e-1'").get() as { message_id: number | null; campaign_id: string | null };
  assert.deepEqual({ ...ev }, { message_id: null, campaign_id: null });
});
