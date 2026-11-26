import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSuppression, suppressedReason } from '../src/core.ts';
import { listMembers, listStatus, listSubscribe, upsertList } from '../src/lists.ts';
import {
  findUnsubToken, handleUnsubMail, handleUnsubRequest, pageText, resubscribeByClaims, signUnsubToken, unsubscribeLinks, unsubscribeLinksForEmail,
  unsubscribeByClaims, unsubSecrets, verifyUnsubToken, type UnsubHandlerConfig,
} from '../src/unsub.ts';
import { count, listDb } from './lists-helpers.ts';

const SECRET = 'test-secret-aaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'old-secret-bbbbbbbbbbbbbbbbbbbbbbbbbb';
const secrets = unsubSecrets(SECRET);
const LINKS = { baseUrl: 'https://u.example.com', mailtoAddress: 'unsubscribe@mail.example.com' };

async function setup() {
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly <News>' });
  await upsertList(db, { id: 'promo', name: 'Promo' });
  for (const l of ['weekly', 'promo']) await listSubscribe(db, { list: l, email: 'a@example.com' });
  await listSubscribe(db, { list: 'weekly', email: 'b@example.com' });
  const id = (email: string) => Number((db.raw.prepare('SELECT id FROM contacts WHERE email = ?').get(email) as { id: number }).id);
  const member = (list: string, email: string) => db.raw.prepare('SELECT m.* FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?').get(list, email) as Record<string, unknown>;
  return { db, id, member };
}
const cfg = (over: Partial<UnsubHandlerConfig> = {}): UnsubHandlerConfig => ({ secrets, ...over });
const req = (method: string, path: string, body?: string) =>
  new Request(`https://u.example.com${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(new TextEncoder().encode(body).length) }, body });

// ---------- 退訂券 ----------

test('券：簽了能驗、帶期別、不含信箱明文', async () => {
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: 123456, campaign: 'weekly-162' });
  assert.deepEqual(await verifyUnsubToken(secrets, token), { list: 'weekly', contactId: 123456, campaign: 'weekly-162' });
  assert.deepEqual(await verifyUnsubToken(secrets, await signUnsubToken(secrets, { list: 'weekly', contactId: 7 })), { list: 'weekly', contactId: 7, campaign: null });
  assert.ok(!token.includes('@'));
  assert.match(token, /^[A-Za-z0-9._-]+$/);
});

test('券：竄改（換人、換名單、換期別、改簽章、缺段、亂字串）一律驗不過', async () => {
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: 10, campaign: 'weekly-1' });
  const [f, list, id, camp, sig] = token.split('.');
  const bad = [
    [f, list, (11).toString(36), camp, sig], // 換人
    [f, 'promo', id, camp, sig], // 換名單
    [f, list, id, 'weekly-2', sig], // 換期別
    [f, list, id, camp, (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)], // 簽章改一字
    [f, list, id, camp, sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A')], // 簽章最後一字（只是換寫法，也不收）
    ['2', list, id, camp, sig], // 版本
    [f, list, id, camp], // 缺段
  ].map((p) => p.join('.'));
  for (const b of [...bad, '', 'x', 'a.b.c.d.e', token + '.extra', token.toUpperCase(), 'x'.repeat(500)]) assert.equal(await verifyUnsubToken(secrets, b), null, b.slice(0, 30));
  assert.equal(await verifyUnsubToken(secrets, undefined), null);
  assert.equal(await verifyUnsubToken(secrets, 42), null);
});

test('券：別把鑰匙簽的不認；換鑰匙的過渡期舊鑰匙還能驗，過了就失效；新券一律用新鑰匙簽', async () => {
  const oldToken = await signUnsubToken(unsubSecrets(OLD), { list: 'weekly', contactId: 5 });
  assert.equal(await verifyUnsubToken(secrets, oldToken), null);
  const transition = unsubSecrets(SECRET, OLD);
  assert.deepEqual(await verifyUnsubToken(transition, oldToken), { list: 'weekly', contactId: 5, campaign: null });
  const fresh = await signUnsubToken(transition, { list: 'weekly', contactId: 5 });
  assert.notEqual(fresh, oldToken);
  assert.ok(await verifyUnsubToken(secrets, fresh)); // 新券只靠新鑰匙就能驗
  assert.equal(await verifyUnsubToken(unsubSecrets(SECRET), oldToken), null); // 過渡期結束
  assert.deepEqual(unsubSecrets(SECRET, ' a ,, b '), [SECRET, 'a', 'b']);
});

test('券：沒鑰匙、鑰匙太短＝簽不出來也驗不過（不會簽出弱券）', async () => {
  await assert.rejects(signUnsubToken([], { list: 'weekly', contactId: 1 }), /unsub_secret/);
  await assert.rejects(signUnsubToken(['short'], { list: 'weekly', contactId: 1 }), /unsub_secret/);
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: 1 });
  assert.equal(await verifyUnsubToken(['short'], token), null);
  await assert.rejects(signUnsubToken(secrets, { list: 'Bad List', contactId: 1 }), /bad_list/);
  await assert.rejects(signUnsubToken(secrets, { list: 'weekly', contactId: 0 }), /bad_contact/);
  await assert.rejects(signUnsubToken(secrets, { list: 'weekly', contactId: 1, campaign: 'a.b' }), /bad_campaign/);
});

test('連結與標頭：List-Unsubscribe 兩段＋One-Click；沒設 mailto 就只有網址；網址必須 https', async () => {
  const l = await unsubscribeLinks(secrets, LINKS, { list: 'weekly', contactId: 9 });
  assert.equal(l.url, `https://u.example.com/u/${l.token}`);
  assert.equal(l.mailto, `mailto:unsubscribe@mail.example.com?subject=${l.token}`);
  assert.equal(l.headers['List-Unsubscribe'], `<${l.url}>, <${l.mailto}>`);
  assert.equal(l.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const only = await unsubscribeLinks(secrets, { baseUrl: 'https://u.example.com/' }, { list: 'weekly', contactId: 9 });
  assert.equal(only.mailto, null);
  assert.equal(only.headers['List-Unsubscribe'], `<https://u.example.com/u/${only.token}>`);
  await assert.rejects(unsubscribeLinks(secrets, { baseUrl: 'http://u.example.com' }, { list: 'weekly', contactId: 9 }), /https/);
  await assert.rejects(unsubscribeLinks(secrets, { baseUrl: '' }, { list: 'weekly', contactId: 9 }), /https/);
  await assert.rejects(unsubscribeLinks(secrets, { ...LINKS, mailtoAddress: 'a b@x' }, { list: 'weekly', contactId: 9 }), /mailto/);
});

test('連結：用信箱找人；非成員、壞信箱回 null', async () => {
  const { db, id } = await setup();
  const l = await unsubscribeLinksForEmail(db, secrets, LINKS, { list: 'weekly', email: ' A@Example.com ', campaign: 'weekly-3' });
  assert.deepEqual(await verifyUnsubToken(secrets, l!.token), { list: 'weekly', contactId: id('a@example.com'), campaign: 'weekly-3' });
  assert.equal(await unsubscribeLinksForEmail(db, secrets, LINKS, { list: 'weekly', email: 'ghost@example.com' }), null);
  assert.equal(await unsubscribeLinksForEmail(db, secrets, LINKS, { list: 'weekly', email: 'bad' }), null);
});

// ---------- 退訂頁（GET 不生效、POST 生效） ----------

test('GET 只顯示確認頁、什麼都不寫；名單名稱已跳脫；帶隱私與安全標頭', async () => {
  const { db, id, member } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  const before = JSON.stringify(member('weekly', 'a@example.com'));
  for (const method of ['GET', 'HEAD']) {
    const res = (await handleUnsubRequest(db, cfg(), req(method, `/u/${token}`)))!;
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    if (method === 'GET') {
      const html = await res.text();
      assert.match(html, /Unsubscribe from Weekly &lt;News&gt;\?/);
      assert.ok(!html.includes('<News>'));
      assert.match(html, /<form method="post"/);
      for (const r of ['too_many', 'not_relevant', 'never_subscribed', 'other']) assert.ok(html.includes(`value="${r}"`));
      assert.ok(!/less|fewer|少收/i.test(html), '不提供「改成少收」');
    }
  }
  assert.equal(JSON.stringify(member('weekly', 'a@example.com')), before);
  assert.equal(member('weekly', 'a@example.com').status, 'subscribed');
});

test('POST（按鈕）退訂：記時間、來源 link、原因；只動這一份名單', async () => {
  const { db, id, member } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com'), campaign: 'weekly-9' });
  const res = (await handleUnsubRequest(db, cfg({ now: () => new Date('2027-03-01T00:00:00Z') }), req('POST', `/u/${token}`, 'reason=too_many')))!;
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You are unsubscribed/);
  const w = member('weekly', 'a@example.com');
  assert.equal(w.status, 'unsubscribed');
  assert.equal(w.unsub_source, 'link');
  assert.equal(w.unsub_reason, 'too_many');
  assert.equal(w.unsubscribed_at, '2027-03-01T00:00:00.000Z');
  assert.equal(member('promo', 'a@example.com').status, 'subscribed'); // 退一份不影響另一份
  assert.equal(member('weekly', 'b@example.com').status, 'subscribed'); // 別人不受影響
  assert.equal(count(db, 'suppressions'), 0); // 不進全域拒收
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.equal(await listStatus(db, { list: 'promo', email: 'a@example.com' }), 'subscribed');
});

test('POST 一鍵退訂（List-Unsubscribe=One-Click）：來源 one_click、沒有原因；不認得的原因被忽略', async () => {
  const { db, id, member } = await setup();
  const t1 = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  const res = (await handleUnsubRequest(db, cfg(), req('POST', `/u/${t1}`, 'List-Unsubscribe=One-Click')))!;
  assert.equal(res.status, 200);
  assert.equal(member('weekly', 'a@example.com').unsub_source, 'one_click');
  assert.equal(member('weekly', 'a@example.com').unsub_reason, null);
  const t2 = await signUnsubToken(secrets, { list: 'weekly', contactId: id('b@example.com') });
  await handleUnsubRequest(db, cfg(), req('POST', `/u/${t2}`, 'reason=<script>alert(1)</script>'));
  assert.equal(member('weekly', 'b@example.com').status, 'unsubscribed');
  assert.equal(member('weekly', 'b@example.com').unsub_reason, null);
});

test('重複退訂：回同一個成功頁，不改原本的時間與來源；之後補選的原因只在原本沒有時補上', async () => {
  const { db, id, member } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  await handleUnsubRequest(db, cfg({ now: () => new Date('2027-03-01T00:00:00Z') }), req('POST', `/u/${token}`, 'List-Unsubscribe=One-Click'));
  const again = (await handleUnsubRequest(db, cfg({ now: () => new Date('2027-03-05T00:00:00Z') }), req('POST', `/u/${token}`, 'reason=other')))!;
  assert.equal(again.status, 200);
  assert.match(await again.text(), /You are unsubscribed/);
  const w = member('weekly', 'a@example.com');
  assert.equal(w.unsubscribed_at, '2027-03-01T00:00:00.000Z');
  assert.equal(w.unsub_source, 'one_click');
  assert.equal(w.unsub_reason, 'other');
  await handleUnsubRequest(db, cfg(), req('POST', `/u/${token}`, 'reason=too_many'));
  assert.equal(member('weekly', 'a@example.com').unsub_reason, 'other');
});

test('壞券：GET／POST 都 404，不說哪裡錯、不寫任何東西，並通知 hook', async () => {
  const { db, member } = await setup();
  const seen: string[] = [];
  const c = cfg({ onInvalidToken: (t, via) => void seen.push(`${via}:${t}`) });
  for (const method of ['GET', 'POST']) {
    const res = (await handleUnsubRequest(db, c, req(method, '/u/not-a-token', method === 'POST' ? 'List-Unsubscribe=One-Click' : undefined)))!;
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /not valid/);
    assert.ok(!/signature|hmac|secret/i.test(html));
  }
  assert.deepEqual(seen, ['page:not-a-token', 'page:not-a-token']);
  assert.equal(member('weekly', 'a@example.com').status, 'subscribed');
  // hook 自己丟錯也不影響回應
  const res = (await handleUnsubRequest(db, cfg({ onInvalidToken: () => { throw new Error('boom'); } }), req('GET', '/u/zzz')))!;
  assert.equal(res.status, 404);
});

test('券換人／換名單不能退到別人：簽名綁死 list 與 contact', async () => {
  const { db, id, member } = await setup();
  const tokenA = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  const [f, list, , camp, sig] = tokenA.split('.');
  const forged = [f, list, id('b@example.com').toString(36), camp, sig].join('.');
  assert.equal((await handleUnsubRequest(db, cfg(), req('POST', `/u/${forged}`, 'List-Unsubscribe=One-Click')))!.status, 404);
  assert.equal(member('weekly', 'b@example.com').status, 'subscribed');
});

test('其他路徑回 null；方法不對回 405；POST 內文過大回 413', async () => {
  const { db, id } = await setup();
  assert.equal(await handleUnsubRequest(db, cfg(), req('GET', '/v1/send')), null);
  assert.equal(await handleUnsubRequest(db, cfg(), req('GET', '/')), null);
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  assert.equal((await handleUnsubRequest(db, cfg(), req('DELETE', `/u/${token}`)))!.status, 405);
  assert.equal((await handleUnsubRequest(db, cfg(), req('GET', `/u/${token}/resubscribe`)))!.status, 405);
  const big = 'reason=' + 'x'.repeat(10_000);
  assert.equal((await handleUnsubRequest(db, cfg(), req('POST', `/u/${token}`, big)))!.status, 413);
});

test('資料庫寫不進去：POST 回 503（信箱商會重試）；沒設鑰匙也是 503', async () => {
  const { db, id } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  const broken = { prepare: () => { throw new Error('d1 down'); } };
  const res = (await handleUnsubRequest(broken, cfg(), req('POST', `/u/${token}`, 'List-Unsubscribe=One-Click')))!;
  assert.equal(res.status, 503);
  assert.match(await res.text(), /try again/i);
  assert.equal((await handleUnsubRequest(db, { secrets: [] }, req('GET', `/u/${token}`)))!.status, 503);
});

test('頁面文字可設定：只蓋寫了的欄位、跳脫、型別不對不收；讀不懂的 JSON 退回預設', async () => {
  const { db, id } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  const text = pageText(JSON.stringify({ confirmTitle: 'Bye <b>{list}</b>', confirmButton: 5, reasons: { other: 'Other thing' }, nope: 'x' }));
  const html = await (await handleUnsubRequest(db, cfg({ text }), req('GET', `/u/${token}`)))!.text();
  assert.match(html, /Bye &lt;b&gt;Weekly &lt;News&gt;&lt;\/b&gt;/);
  assert.match(html, /Confirm unsubscribe/); // 型別不對的欄位沒被蓋
  assert.match(html, /Other thing/);
  assert.match(html, /Too many emails/);
  assert.equal(pageText('{bad json').confirmButton, 'Confirm unsubscribe');
  assert.equal(pageText(null).lang, 'en');
});

test('onUnsubscribed hook：成功退訂才呼叫，帶來源與原因', async () => {
  const { db, id } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com'), campaign: 'weekly-4' });
  const got: unknown[] = [];
  await handleUnsubRequest(db, cfg({ onUnsubscribed: (i) => void got.push(i) }), req('POST', `/u/${token}`, 'reason=not_relevant'));
  assert.deepEqual(got, [{ claims: { list: 'weekly', contactId: id('a@example.com'), campaign: 'weekly-4' }, source: 'link', reason: 'not_relevant' }]);
});

// ---------- 反悔 ----------

test('反悔：30 天內同一張券訂回來，退訂欄位清空；超過 30 天不行', async () => {
  const { db, id, member } = await setup();
  const claims = { list: 'weekly', contactId: id('a@example.com') };
  const token = await signUnsubToken(secrets, claims);
  await handleUnsubRequest(db, cfg({ now: () => new Date('2027-03-01T00:00:00Z') }), req('POST', `/u/${token}`, 'reason=too_many'));
  const ok = (await handleUnsubRequest(db, cfg({ now: () => new Date('2027-03-30T00:00:00Z') }), req('POST', `/u/${token}/resubscribe`, '')))!;
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Welcome back/);
  const w = member('weekly', 'a@example.com');
  assert.deepEqual([w.status, w.unsubscribed_at, w.unsub_source, w.unsub_reason], ['subscribed', null, null, null]);
  // 再按一次（已經訂回）＝一樣成功
  assert.equal((await handleUnsubRequest(db, cfg(), req('POST', `/u/${token}/resubscribe`, '')))!.status, 200);
  // 再退一次，這次超過 30 天才反悔
  await handleUnsubRequest(db, cfg({ now: () => new Date('2027-04-01T00:00:00Z') }), req('POST', `/u/${token}`, 'List-Unsubscribe=One-Click'));
  const late = (await handleUnsubRequest(db, cfg({ now: () => new Date('2027-05-02T00:00:00Z') }), req('POST', `/u/${token}/resubscribe`, '')))!;
  assert.equal(late.status, 409);
  assert.match(await late.text(), /no longer restore/);
  assert.equal(member('weekly', 'a@example.com').status, 'unsubscribed');
});

test('反悔：檢舉、匯入、人工 API 的退訂不能用券反悔；在全域拒收的不能；券換不了別人', async () => {
  const { db, id, member } = await setup();
  const a = { list: 'weekly', contactId: id('a@example.com') };
  db.raw.prepare("UPDATE list_members SET status='unsubscribed', unsub_source='complaint', unsubscribed_at=? WHERE list_id='weekly' AND contact_id=?").run('2027-03-01T00:00:00.000Z', a.contactId);
  assert.equal((await resubscribeByClaims(db, a, () => new Date('2027-03-02T00:00:00Z'))).status, 'expired');
  db.raw.prepare("UPDATE list_members SET unsub_source='api' WHERE list_id='weekly' AND contact_id=?").run(a.contactId);
  assert.equal((await resubscribeByClaims(db, a, () => new Date('2027-03-02T00:00:00Z'))).status, 'expired');
  db.raw.prepare("UPDATE list_members SET unsub_source='link' WHERE list_id='weekly' AND contact_id=?").run(a.contactId);
  await addSuppression(db, 'a@example.com', 'hard_bounce', 'test', null);
  assert.equal((await resubscribeByClaims(db, a, () => new Date('2027-03-02T00:00:00Z'))).status, 'blocked');
  assert.equal(member('weekly', 'a@example.com').status, 'unsubscribed');
  assert.equal((await resubscribeByClaims(db, { list: 'weekly', contactId: 99999 })).status, 'not_found');
});

// ---------- 收信退訂（mailto） ----------

test('mailto：主旨帶券就退訂（來源 mailto），主旨前面可以有 Re: 之類；重複寄安全', async () => {
  const { db, id, member } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  assert.equal(findUnsubToken(`Re: ${token} please`), token);
  assert.equal(findUnsubToken('unsubscribe me'), null);
  assert.equal(await handleUnsubMail(db, cfg(), { from: 'a@example.com', subject: `Re: ${token}` }), 'unsubscribed');
  assert.equal(member('weekly', 'a@example.com').status, 'unsubscribed');
  assert.equal(member('weekly', 'a@example.com').unsub_source, 'mailto');
  assert.equal(member('promo', 'a@example.com').status, 'subscribed');
  assert.equal(await handleUnsubMail(db, cfg(), { subject: token }), 'unsubscribed');
});

test('mailto：沒券交給 onNoToken（人工）、假券不退訂並通知 hook、寄件人不同也不影響（轉寄的信箱）', async () => {
  const { db, id, member } = await setup();
  const noToken: unknown[] = [];
  const bad: string[] = [];
  const c = { ...cfg({ onInvalidToken: (t, via) => void bad.push(`${via}:${t.slice(0, 4)}`) }), onNoToken: (m: unknown) => void noToken.push(m) };
  assert.equal(await handleUnsubMail(db, c, { from: 'a@example.com', subject: 'unsubscribe' }), 'no_token');
  assert.equal(noToken.length, 1);
  const forged = (await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') })).replace(/.$/, (ch) => (ch === 'A' ? 'B' : 'A'));
  assert.equal(await handleUnsubMail(db, c, { subject: forged }), 'invalid_token');
  assert.deepEqual(bad, ['mailto:1.we']);
  assert.equal(member('weekly', 'a@example.com').status, 'subscribed');
  const real = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  assert.equal(await handleUnsubMail(db, c, { from: 'someone-else@example.org', subject: real }), 'unsubscribed');
  assert.equal(await handleUnsubMail(db, c, { subject: null }), 'no_token');
});

// ---------- 退訂後的行為 ----------

test('退訂後：這份名單的成員清單看得到狀態與原因；寄送端的拒收查詢不受影響（單份退訂不進全域拒收）', async () => {
  const { db, id } = await setup();
  const token = await signUnsubToken(secrets, { list: 'weekly', contactId: id('a@example.com') });
  await handleUnsubRequest(db, cfg(), req('POST', `/u/${token}`, 'reason=never_subscribed'));
  const page = (await listMembers(db, { list: 'weekly', status: 'unsubscribed' })) as { members: Array<Record<string, unknown>> };
  assert.equal(page.members.length, 1);
  assert.equal(page.members[0].unsubReason, 'never_subscribed');
  assert.equal(page.members[0].suppressed, false);
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), null);
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), null);
});

test('unsubscribeByClaims：券是真的但名單沒這個人 → not_found（呼叫端仍可顯示已退訂）', async () => {
  const { db } = await setup();
  assert.deepEqual(await unsubscribeByClaims(db, { list: 'weekly', contactId: 424242 }, 'link'), { status: 'not_found' });
  const ok = (await handleUnsubRequest(db, cfg(), req('POST', `/u/${await signUnsubToken(secrets, { list: 'weekly', contactId: 424242 })}`, 'List-Unsubscribe=One-Click')))!;
  assert.equal(ok.status, 200);
});
