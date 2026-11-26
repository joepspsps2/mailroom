import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetAlertWarning, sendAlert, warnIfNoAlert } from '../src/alert.ts';
import { handleEmailMessage, WRITE_FAILED_REJECT, type InboundMail, type UnsubEnv } from '../src/unsub-wiring.ts';
import { signUnsubToken, unsubSecrets } from '../src/unsub.ts';
import { listSubscribe, upsertList } from '../src/lists.ts';
import { listDb } from './lists-helpers.ts';

const SECRET = 'test-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
const env: UnsubEnv = { UNSUB_TOKEN_SECRET: SECRET, UNSUB_ALERT_WEBHOOK: 'https://alerts.example.com/hook', UNSUB_ALERT_TOKEN: 'alert-token' };

type Sent = { url: string; headers: Record<string, string>; body: Record<string, string> };
function fakeFetch(status = 200, sent: Sent[] = []): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
    return new Response('ok', { status });
  }) as typeof fetch;
}
function mail(subject: string | null, from = 'reader@example.org') {
  const rejected: string[] = [];
  const m: InboundMail = { from, headers: { get: (n: string) => (n.toLowerCase() === 'subject' ? subject : null) }, setReject: (r) => void rejected.push(r) };
  return { m, rejected };
}
async function setup() {
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly' });
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  const id = Number((db.raw.prepare("SELECT id FROM contacts WHERE email = 'a@example.com'").get() as { id: number }).id);
  const token = await signUnsubToken(unsubSecrets(SECRET), { list: 'weekly', contactId: id });
  return { db, id, token };
}
const quiet = () => {
  const orig = [console.error, console.warn, console.log];
  const lines: string[] = [];
  console.error = (...a: unknown[]) => void lines.push(a.join(' '));
  console.warn = (...a: unknown[]) => void lines.push(a.join(' '));
  console.log = () => undefined;
  return { lines, restore: () => { [console.error, console.warn, console.log] = orig; } };
};
beforeEach(() => resetAlertWarning());

test('email()：帶券的信退訂成功，不告警、不退信', async () => {
  const { db, token } = await setup();
  const sent: Sent[] = [];
  const q = quiet();
  const { m, rejected } = mail(`Re: ${token}`);
  const out = await handleEmailMessage(db, env, m, fakeFetch(200, sent));
  q.restore();
  assert.equal(out, 'unsubscribed');
  assert.equal(sent.length, 0);
  assert.equal(rejected.length, 0);
  assert.equal((db.raw.prepare("SELECT status FROM list_members").get() as { status: string }).status, 'unsubscribed');
});

test('email()：沒帶券 → 告警（含寄件人與主旨），信不退', async () => {
  const { db } = await setup();
  const sent: Sent[] = [];
  const q = quiet();
  const { m, rejected } = mail('please remove me', 'reader@example.org');
  const out = await handleEmailMessage(db, env, m, fakeFetch(200, sent));
  q.restore();
  assert.equal(out, 'no_token');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, 'https://alerts.example.com/hook');
  assert.equal(sent[0].headers.authorization, 'Bearer alert-token');
  assert.equal(sent[0].body.event, 'unsub_mail_no_token');
  assert.equal(sent[0].body.from, 'reader@example.org');
  assert.equal(sent[0].body.subject, 'please remove me');
  assert.ok(sent[0].body.text.length > 0 && sent[0].body.content === sent[0].body.text);
  assert.equal(rejected.length, 0);
});

test('email()：券驗不過 → 告警帶完整券與寄件人；沒有退訂任何人', async () => {
  const { db, token } = await setup();
  const forged = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
  const sent: Sent[] = [];
  const q = quiet();
  const out = await handleEmailMessage(db, env, mail(forged, 'x@example.org').m, fakeFetch(200, sent));
  q.restore();
  assert.equal(out, 'invalid_token');
  assert.equal(sent[0].body.event, 'unsub_token_invalid');
  assert.equal(sent[0].body.token, forged);
  assert.equal(sent[0].body.from, 'x@example.org');
  assert.equal(sent[0].body.via, 'mailto');
  assert.equal((db.raw.prepare("SELECT status FROM list_members").get() as { status: string }).status, 'subscribed');
});

test('email()：資料庫寫入失敗 → 告警（完整券、寄件人）＋ setReject 退信給寄件人', async () => {
  const { token } = await setup();
  const broken = { prepare: () => { throw new Error('d1 down'); } };
  const sent: Sent[] = [];
  const q = quiet();
  const { m, rejected } = mail(token, 'reader@example.org');
  const out = await handleEmailMessage(broken, env, m, fakeFetch(200, sent));
  q.restore();
  assert.equal(out, 'failed');
  assert.deepEqual(rejected, [WRITE_FAILED_REJECT]);
  assert.equal(sent[0].body.event, 'unsub_write_failed');
  assert.equal(sent[0].body.token, token);
  assert.equal(sent[0].body.from, 'reader@example.org');
});

test('告警 webhook 沒設：不呼叫網路，完整內容仍寫進 log，啟動警告只出現一次', async () => {
  const { db, token } = await setup();
  const noHook: UnsubEnv = { UNSUB_TOKEN_SECRET: SECRET };
  const q = quiet();
  let called = 0;
  const f = (async () => { called++; return new Response('ok'); }) as typeof fetch;
  await handleEmailMessage(db, noHook, mail('remove me', 'reader@example.org').m, f);
  await handleEmailMessage(db, noHook, mail('remove me too', 'other@example.org').m, f);
  q.restore();
  assert.equal(called, 0);
  assert.ok(q.lines.some((l) => l.includes('reader@example.org') && l.includes('unsub_mail_no_token')));
  assert.equal(q.lines.filter((l) => l.includes('UNSUB_ALERT_WEBHOOK is not set')).length, 1);
  void token;
});

test('告警 webhook 壞掉或逾時：不丟錯、不影響處理，內容仍在 log', async () => {
  const { db } = await setup();
  const q = quiet();
  const failing = (async () => { throw new Error('network'); }) as typeof fetch;
  assert.equal(await handleEmailMessage(db, env, mail('hello').m, failing), 'no_token');
  assert.equal(await handleEmailMessage(db, env, mail('hello').m, fakeFetch(500)), 'no_token');
  q.restore();
  assert.ok(q.lines.some((l) => l.includes('webhook failed')));
  assert.ok(q.lines.some((l) => l.includes('webhook status 500')));
});

test('sendAlert：只收 https 網址；warnIfNoAlert 回傳有沒有設', async () => {
  const q = quiet();
  assert.equal(await sendAlert({ url: 'http://alerts.example.com/x', fetch: fakeFetch() }, { event: 'unsub_mail_no_token' }), false);
  assert.equal(await sendAlert({ url: 'https://alerts.example.com/x', fetch: fakeFetch() }, { event: 'unsub_mail_no_token' }), true);
  q.restore();
  assert.equal(warnIfNoAlert('https://x.example.com'), true);
});
