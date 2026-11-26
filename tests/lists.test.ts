import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSuppression, suppressedReason } from '../src/core.ts';
import { importMembers, listMembers, listStatus, listSubscribe, listUnsubscribe, NEW_SEGMENT, normalizeEmail, setSegments, upsertList, type ImportRow } from '../src/lists.ts';
import { count, listDb } from './lists-helpers.ts';

async function setup(withBatch = true) {
  const db = listDb(withBatch);
  await upsertList(db, { id: 'weekly', name: 'Weekly' });
  await upsertList(db, { id: 'promo', name: 'Promo' });
  return db;
}
const member = (db: ReturnType<typeof listDb>, list: string, email: string) =>
  db.raw.prepare('SELECT m.* FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?').get(list, email) as Record<string, unknown> | undefined;

test('信箱一律小寫去空白，壞格式不收', () => {
  assert.equal(normalizeEmail('  A@Example.COM '), 'a@example.com');
  assert.equal(normalizeEmail('nope'), null);
  assert.equal(normalizeEmail('a b@example.com'), null);
  assert.equal(normalizeEmail(42), null);
});

test('名單：建立、同 id 再建＝改名；壞 id 與空名稱被擋', async () => {
  const db = await setup();
  assert.deepEqual(await upsertList(db, { id: 'weekly', name: 'Renamed', fromAddr: 'news@mail.example.com' }), { ok: true });
  assert.equal(count(db, 'lists'), 2);
  assert.equal((db.raw.prepare("SELECT name, from_addr FROM lists WHERE id='weekly'").get() as { name: string }).name, 'Renamed');
  assert.deepEqual(await upsertList(db, { id: 'Bad_Id', name: 'x' }), { ok: false, reason: 'bad_list' });
  assert.deepEqual(await upsertList(db, { id: 'ok', name: '  ' }), { ok: false, reason: 'bad_name' });
});

test('加入：新加入、已在、大小寫視為同一人；預設分群＝新進觀察群', async () => {
  const db = await setup();
  assert.deepEqual(await listSubscribe(db, { list: 'weekly', email: 'A@Example.com', source: 'site-card', consentVersion: 'v1' }), { status: 'subscribed' });
  assert.deepEqual(await listSubscribe(db, { list: 'weekly', email: ' a@example.com ', source: 'other' }), { status: 'already' });
  assert.equal(count(db, 'contacts'), 1);
  const m = member(db, 'weekly', 'a@example.com')!;
  assert.equal(m.source, 'site-card'); // already 不改來源
  assert.equal(m.consent_version, 'v1');
  assert.equal(m.segment, NEW_SEGMENT);
  assert.equal(m.status, 'subscribed');
});

test('加入：壞信箱、未知名單被拒', async () => {
  const db = await setup();
  assert.deepEqual(await listSubscribe(db, { list: 'weekly', email: 'x' }), { status: 'rejected', reason: 'bad_email' });
  assert.deepEqual(await listSubscribe(db, { list: 'nope', email: 'a@example.com' }), { status: 'rejected', reason: 'unknown_list' });
  assert.deepEqual(await listSubscribe(db, { list: 'BAD', email: 'a@example.com' }), { status: 'rejected', reason: 'bad_list' });
  assert.equal(count(db, 'contacts'), 0);
});

test('加入：硬退信、檢舉、「全部不要」都擋，且不留成員', async () => {
  const db = await setup();
  for (const [email, reason] of [['b@example.com', 'hard_bounce'], ['c@example.com', 'complaint'], ['u@example.com', 'unsubscribe']] as const) {
    await addSuppression(db, email, reason, 'manual', null);
    assert.deepEqual(await listSubscribe(db, { list: 'weekly', email }), { status: 'blocked' });
  }
  assert.equal(count(db, 'list_members'), 0);
});

test('退出：unsubscribed／not_member；重複退出不改原本的時間與來源', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  assert.deepEqual(await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'link' }, () => new Date('2027-01-01T00:00:00Z')), { status: 'unsubscribed' });
  assert.deepEqual(await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'api' }, () => new Date('2027-02-01T00:00:00Z')), { status: 'unsubscribed' });
  const m = member(db, 'weekly', 'a@example.com')!;
  assert.equal(m.unsub_source, 'link');
  assert.equal(m.unsubscribed_at, '2027-01-01T00:00:00.000Z');
  assert.deepEqual(await listUnsubscribe(db, { list: 'weekly', email: 'ghost@example.com' }), { status: 'not_member' });
  assert.deepEqual(await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'bogus' as never }), { status: 'rejected', reason: 'bad_source' });
});

test('再訂回：讀者本人加入可把退訂改回訂閱，退訂欄位清空、來源記新入口', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'old' });
  await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'one_click' });
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.deepEqual(await listSubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'new-entry', consentVersion: 'v2' }), { status: 'subscribed' });
  const m = member(db, 'weekly', 'a@example.com')!;
  assert.equal(m.status, 'subscribed');
  assert.equal(m.unsubscribed_at, null);
  assert.equal(m.unsub_source, null);
  assert.equal(m.source, 'new-entry');
  assert.equal(m.consent_version, 'v2');
  assert.equal(count(db, 'list_members'), 1);
});

test('同一人兩份名單，退一份不影響另一份，也不進全域拒收', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  await listSubscribe(db, { list: 'promo', email: 'a@example.com' });
  assert.equal(count(db, 'contacts'), 1);
  await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'link' });
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.equal(await listStatus(db, { list: 'promo', email: 'a@example.com' }), 'subscribed');
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), null);
  assert.equal(count(db, 'suppressions'), 0);
});

test('查狀態：四種結果；訂閱中但被全域拒收＝blocked，已退訂仍顯示 unsubscribed', async () => {
  const db = await setup();
  assert.equal(await listStatus(db, { list: 'weekly', email: 'nobody@example.com' }), 'not_found');
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'subscribed');
  await addSuppression(db, 'a@example.com', 'hard_bounce', 'resend-webhook', null);
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'blocked');
  await addSuppression(db, 'z@example.com', 'complaint', 'manual', null);
  assert.equal(await listStatus(db, { list: 'weekly', email: 'z@example.com' }), 'blocked');
  await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com' });
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.deepEqual(await listStatus(db, { list: 'weekly', email: 'bad' }), { status: 'rejected', reason: 'bad_email' });
});

test('分頁列出：一頁 limit 筆、cursor 接得上、可依狀態篩、5,000 筆不漏不重', async () => {
  const db = await setup();
  const rows: ImportRow[] = Array.from({ length: 1500 }, (_, i) => ({ email: `u${i}@example.com`, status: i % 3 === 0 ? 'unsubscribed' : 'subscribed' }));
  const r = await importMembers(db, 'weekly', rows, { importedFrom: 'test' });
  assert.ok(r.ok);
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await listMembers(db, { list: 'weekly', status: 'subscribed', cursor });
    assert.ok('members' in page);
    assert.ok(page.members.length <= 1000);
    seen.push(...page.members.map((m) => m.email));
    cursor = page.next;
    pages++;
  } while (cursor);
  assert.equal(pages, 1); // 1,000 筆訂閱中 → 剛好一頁，沒有多出的空頁
  assert.equal(seen.length, 1000);
  assert.equal(new Set(seen).size, 1000);
  const small: string[] = [];
  cursor = null;
  do {
    const page = await listMembers(db, { list: 'weekly', cursor, limit: 400 });
    assert.ok('members' in page);
    small.push(...page.members.map((m) => m.email));
    cursor = page.next;
  } while (cursor);
  assert.equal(small.length, 1500);
  assert.equal(new Set(small).size, 1500);
  assert.deepEqual(await listMembers(db, { list: 'weekly', cursor: 'x1' }), { status: 'rejected', reason: 'bad_cursor' });
  assert.deepEqual(await listMembers(db, { list: 'weekly', status: 'bogus' as never }), { status: 'rejected', reason: 'bad_status' });
});

test('分群欄位：只更新成員、不建立新人、冪等；無效列略過；不影響別份名單', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  await listSubscribe(db, { list: 'promo', email: 'a@example.com' });
  const items = [{ email: 'A@example.com', segment: 'active', segmentLabel: 'core' }, { email: 'ghost@example.com', segment: 'active' }, { email: 'bad', segment: 'x' }, { email: 'b@example.com', segment: '' }];
  const t = () => new Date('2027-01-07T00:00:00Z');
  assert.deepEqual(await setSegments(db, 'weekly', items, t), { ok: true, updated: 1, notMember: 1, invalid: 2 });
  assert.deepEqual(await setSegments(db, 'weekly', items, t), { ok: true, updated: 1, notMember: 1, invalid: 2 });
  const m = member(db, 'weekly', 'a@example.com')!;
  assert.equal(m.segment, 'active');
  assert.equal(m.segment_label, 'core');
  assert.equal(m.segment_at, '2027-01-07T00:00:00.000Z');
  assert.equal(member(db, 'promo', 'a@example.com')!.segment, NEW_SEGMENT);
  assert.equal(count(db, 'contacts'), 1);
  assert.deepEqual(await setSegments(db, 'nope', items), { ok: false, reason: 'unknown_list' });
  assert.deepEqual(await setSegments(db, 'weekly', Array.from({ length: 5001 }, () => ({ email: 'a@example.com', segment: 's' }))), { ok: false, reason: 'too_many' });
});

test('分群欄位：5,000 筆一次寫完', async () => {
  const db = await setup();
  await importMembers(db, 'weekly', Array.from({ length: 2000 }, (_, i) => ({ email: `m${i}@example.com`, status: 'subscribed' as const })), { importedFrom: 't' });
  const items = Array.from({ length: 5000 }, (_, i) => ({ email: `m${i}@example.com`, segment: 'g' }));
  assert.deepEqual(await setSegments(db, 'weekly', items), { ok: true, updated: 2000, notMember: 3000, invalid: 0 });
  assert.equal(count(db, 'list_members', "segment = 'g'"), 2000);
});

const FOUR: ImportRow[] = [
  { email: 'sub@example.com', status: 'subscribed', name: 'Sub', source: 'form-a' },
  { email: 'unsub@example.com', status: 'unsubscribed' },
  { email: 'bounce@example.com', status: 'bounced' },
  { email: 'removed@example.com', status: 'removed' },
  { email: 'complain@example.com', status: 'complained' },
];

test('匯入四種狀態＋人工移除：各自落在對的表，帳對得上', async () => {
  const db = await setup();
  const r = await importMembers(db, 'weekly', FOUR, { importedFrom: 'oldesp', expected: { subscribed: 1, unsubscribed: 1, bounced: 1, removed: 1, complained: 1 } });
  assert.ok(r.ok);
  assert.equal(r.total, 5);
  assert.deepEqual(r.outcomes, { subscribed_new: 1, subscribed_unchanged: 0, kept_unsubscribed: 0, blocked: 0, unsubscribed: 2, unsubscribed_unchanged: 0, suppressed: 2, suppressed_unchanged: 0 });
  const sub = member(db, 'weekly', 'sub@example.com')!;
  assert.equal(sub.status, 'subscribed');
  assert.equal(sub.imported_from, 'oldesp');
  assert.equal(sub.source, 'form-a');
  assert.equal(sub.segment, NEW_SEGMENT);
  assert.equal(member(db, 'weekly', 'unsub@example.com')!.unsub_source, 'import');
  assert.equal(member(db, 'weekly', 'removed@example.com')!.unsub_source, 'import-removed');
  // 退訂與人工移除不進全域拒收（不擋交易信）
  assert.equal(await suppressedReason(db, 'removed@example.com', 'transactional'), null);
  assert.equal(await suppressedReason(db, 'unsub@example.com', 'marketing'), null);
  // 退信與檢舉進全域拒收，source＝import，不建立名單成員
  assert.equal(await suppressedReason(db, 'bounce@example.com', 'transactional'), 'hard_bounce');
  assert.equal(await suppressedReason(db, 'complain@example.com', 'transactional'), 'complaint');
  assert.equal(count(db, 'suppressions', "source = 'import'"), 2);
  assert.equal(member(db, 'weekly', 'bounce@example.com'), undefined);
  assert.equal(count(db, 'list_members'), 3);
});

test('重複匯入同一批：結果不變、不重複', async () => {
  const db = await setup();
  await importMembers(db, 'weekly', FOUR, { importedFrom: 'oldesp' });
  const before = { c: count(db, 'contacts'), m: count(db, 'list_members'), s: count(db, 'suppressions') };
  const again = await importMembers(db, 'weekly', FOUR, { importedFrom: 'oldesp' });
  assert.ok(again.ok);
  assert.deepEqual(again.outcomes, { subscribed_new: 0, subscribed_unchanged: 1, kept_unsubscribed: 0, blocked: 0, unsubscribed: 0, unsubscribed_unchanged: 2, suppressed: 0, suppressed_unchanged: 2 });
  assert.deepEqual({ c: count(db, 'contacts'), m: count(db, 'list_members'), s: count(db, 'suppressions') }, before);
});

test('匯入不准把退訂改回訂閱（兩種來源：本系統退訂、先前匯入退訂）', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  await listUnsubscribe(db, { list: 'weekly', email: 'a@example.com', source: 'link' });
  await importMembers(db, 'weekly', [{ email: 'b@example.com', status: 'unsubscribed' }], { importedFrom: 'x' });
  const r = await importMembers(db, 'weekly', [{ email: 'a@example.com', status: 'subscribed' }, { email: 'b@example.com', status: 'subscribed' }], { importedFrom: 'x' });
  assert.ok(r.ok);
  assert.equal(r.outcomes.kept_unsubscribed, 2);
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.equal(await listStatus(db, { list: 'weekly', email: 'b@example.com' }), 'unsubscribed');
});

test('匯入可以把訂閱改成不寄，且不覆蓋原本的退訂來源', async () => {
  const db = await setup();
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com' });
  await importMembers(db, 'weekly', [{ email: 'a@example.com', status: 'unsubscribed' }], { importedFrom: 'x' });
  assert.equal(member(db, 'weekly', 'a@example.com')!.status, 'unsubscribed');
  assert.equal(member(db, 'weekly', 'a@example.com')!.unsub_source, 'import');
  await importMembers(db, 'weekly', [{ email: 'a@example.com', status: 'removed' }], { importedFrom: 'x' });
  assert.equal(member(db, 'weekly', 'a@example.com')!.unsub_source, 'import'); // 已退訂的不動
});

test('匯入訂閱中但信箱在全域拒收：blocked、不進名單', async () => {
  const db = await setup();
  await addSuppression(db, 'bad@example.com', 'hard_bounce', 'manual', null);
  const r = await importMembers(db, 'weekly', [{ email: 'bad@example.com', status: 'subscribed' }], { importedFrom: 'x' });
  assert.ok(r.ok);
  assert.equal(r.outcomes.blocked, 1);
  assert.equal(count(db, 'list_members'), 0);
});

test('同一批裡同一信箱出現多次：取限制最多的一筆、計入 duplicates，大小寫視為同一人', async () => {
  const db = await setup();
  const r = await importMembers(db, 'weekly', [{ email: 'A@example.com', status: 'subscribed' }, { email: 'a@example.com', status: 'unsubscribed' }, { email: 'a@EXAMPLE.com', status: 'subscribed' }], { importedFrom: 'x' });
  assert.ok(r.ok);
  assert.equal(r.total, 1);
  assert.equal(r.duplicates, 2);
  assert.equal(member(db, 'weekly', 'a@example.com')!.status, 'unsubscribed');
});

test('匯入：有任何壞列整批不寫；筆數對不上也整批不寫', async () => {
  const db = await setup();
  const bad = await importMembers(db, 'weekly', [{ email: 'ok@example.com', status: 'subscribed' }, { email: 'nope', status: 'subscribed' }, { email: 'x@example.com', status: 'weird' as never }], { importedFrom: 'x' });
  assert.deepEqual(bad, { ok: false, reason: 'invalid_rows', problems: [{ index: 1, reason: 'bad_email' }, { index: 2, reason: 'bad_status' }] });
  const mismatch = await importMembers(db, 'weekly', FOUR, { importedFrom: 'x', expected: { subscribed: 2 } });
  assert.equal(mismatch.ok, false);
  assert.equal((mismatch as { reason: string }).reason, 'count_mismatch');
  assert.equal(count(db, 'contacts'), 0);
  assert.equal(count(db, 'list_members'), 0);
  assert.equal(count(db, 'suppressions'), 0);
});

test('匯入：試算（dryRun）回一樣的報告但不寫入；未知名單、缺來源、超量被擋', async () => {
  const db = await setup();
  const dry = await importMembers(db, 'weekly', FOUR, { importedFrom: 'x', dryRun: true });
  assert.ok(dry.ok);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.outcomes.subscribed_new, 1);
  assert.equal(count(db, 'contacts'), 0);
  assert.deepEqual(await importMembers(db, 'nope', FOUR, { importedFrom: 'x' }), { ok: false, reason: 'unknown_list' });
  assert.deepEqual(await importMembers(db, 'weekly', FOUR, { importedFrom: '' }), { ok: false, reason: 'bad_source' });
  assert.deepEqual(await importMembers(db, 'weekly', Array.from({ length: 2001 }, () => FOUR[0]), { importedFrom: 'x' }), { ok: false, reason: 'too_many' });
});

test('匯入的名字不覆蓋已有的名字；沒有 batch 的資料庫也能跑', async () => {
  const db = await setup(false);
  await listSubscribe(db, { list: 'weekly', email: 'a@example.com', name: 'First' });
  await importMembers(db, 'promo', [{ email: 'a@example.com', status: 'subscribed', name: 'Second' }, ...FOUR], { importedFrom: 'x' });
  assert.equal((db.raw.prepare("SELECT name FROM contacts WHERE email='a@example.com'").get() as { name: string }).name, 'First');
  assert.equal(count(db, 'list_members', "list_id = 'promo'"), 4);
});

test('匯入大批（2,000 筆）後與 Moosend 式四狀態合計對得上', async () => {
  const db = await setup();
  const statuses = ['subscribed', 'unsubscribed', 'bounced', 'removed', 'complained'] as const;
  const rows: ImportRow[] = Array.from({ length: 2000 }, (_, i) => ({ email: `p${i}@example.com`, status: statuses[i % 5] }));
  const r = await importMembers(db, 'weekly', rows, { importedFrom: 'x', expected: { subscribed: 400, unsubscribed: 400, bounced: 400, removed: 400, complained: 400 } });
  assert.ok(r.ok);
  assert.equal(count(db, 'list_members', "status = 'subscribed'"), 400);
  assert.equal(count(db, 'list_members', "status = 'unsubscribed'"), 800);
  assert.equal(count(db, 'suppressions'), 800);
  assert.equal(count(db, 'contacts'), 2000);
});
