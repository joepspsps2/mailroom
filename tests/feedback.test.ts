import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suppressedReason } from '../src/core.ts';
import { applyFeedback, TRANSIENT_LIMIT } from '../src/feedback.ts';
import { listMembers, listStatus, listSubscribe, upsertList } from '../src/lists.ts';
import { count, listDb } from './lists-helpers.ts';

async function setup() {
  const db = listDb();
  await upsertList(db, { id: 'weekly', name: 'Weekly' });
  await upsertList(db, { id: 'promo', name: 'Promo' });
  for (const l of ['weekly', 'promo']) await listSubscribe(db, { list: l, email: 'a@example.com' });
  await listSubscribe(db, { list: 'weekly', email: 'b@example.com' });
  const status = (list: string, email: string) => (db.raw.prepare('SELECT m.status, m.unsub_source FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?').get(list, email) as { status: string; unsub_source: string | null });
  return { db, status };
}
const supp = (db: ReturnType<typeof listDb>, email: string) => (db.raw.prepare('SELECT reason, source, detail FROM suppressions WHERE email = ? ORDER BY reason').all(email) as Array<{ reason: string; source: string; detail: string | null }>).map((r) => ({ ...r }));

test('永久退信：進全域拒收 hard_bounce；擋電子報也擋登入類通知信；名單成員狀態不動', async () => {
  const { db, status } = await setup();
  assert.equal(await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: ' A@Example.com ', source: 'ses', detail: 'NoEmail' }), 'hard_bounce');
  assert.deepEqual(supp(db, 'a@example.com'), [{ reason: 'hard_bounce', source: 'ses', detail: 'NoEmail' }]);
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), 'hard_bounce');
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), 'hard_bounce');
  assert.equal(status('weekly', 'a@example.com').status, 'subscribed');
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'blocked');
  assert.equal(await suppressedReason(db, 'b@example.com', 'marketing'), null);
  // 同一則事件再送一次：不重複
  assert.equal(await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: 'a@example.com', source: 'ses' }), 'hard_bounce');
  assert.equal(count(db, 'suppressions'), 1);
});

test('檢舉：進全域拒收 complaint，並把這個人在所有名單退出（來源 complaint）；別人不受影響', async () => {
  const { db, status } = await setup();
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'a@example.com', source: 'ses' }, { now: () => new Date('2027-03-01T00:00:00Z') }), 'complaint');
  assert.deepEqual(supp(db, 'a@example.com').map((r) => r.reason), ['complaint']);
  for (const l of ['weekly', 'promo']) assert.deepEqual({ ...status(l, 'a@example.com') }, { status: 'unsubscribed', unsub_source: 'complaint' });
  assert.equal(status('weekly', 'b@example.com').status, 'subscribed');
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), 'complaint');
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'unsubscribed');
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'a@example.com', source: 'ses' }), 'complaint');
  assert.equal(count(db, 'suppressions'), 1);
});

test('檢舉：已經自己退訂的人，保留原本的退訂時間與來源；不在任何名單的人也進拒收', async () => {
  const { db } = await setup();
  db.raw.prepare("UPDATE list_members SET status='unsubscribed', unsub_source='one_click', unsubscribed_at='2027-01-01T00:00:00.000Z' WHERE list_id='weekly' AND contact_id=(SELECT id FROM contacts WHERE email='a@example.com')").run();
  await applyFeedback(db, { type: 'complaint', email: 'a@example.com', source: 'ses' }, { now: () => new Date('2027-03-01T00:00:00Z') });
  const w = db.raw.prepare("SELECT unsub_source, unsubscribed_at FROM list_members WHERE list_id='weekly' AND contact_id=(SELECT id FROM contacts WHERE email='a@example.com')").get() as Record<string, string>;
  assert.deepEqual({ ...w }, { unsub_source: 'one_click', unsubscribed_at: '2027-01-01T00:00:00.000Z' });
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'stranger@example.com', source: 'ses' }), 'complaint');
  assert.deepEqual(supp(db, 'stranger@example.com').map((r) => r.reason), ['complaint']);
});

test('暫時性退信：單次不擋、同一期重送不重複計數；連續 3 期（三個不同的期）才當硬退信', async () => {
  const { db } = await setup();
  const soft = (campaign: string | null) => applyFeedback(db, { type: 'bounce', kind: 'transient', email: 'a@example.com', campaign, source: 'ses' });
  assert.equal(await soft('weekly-1'), 'transient_counted');
  assert.equal(await soft('weekly-1'), 'transient_counted'); // 同一期重送
  assert.equal(await soft('weekly-2'), 'transient_counted');
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), null);
  assert.equal(count(db, 'bounce_streaks'), 2);
  assert.equal(await soft('weekly-3'), 'transient_promoted');
  assert.deepEqual(supp(db, 'a@example.com'), [{ reason: 'hard_bounce', source: 'ses', detail: `transient_streak:${TRANSIENT_LIMIT}` }]);
  assert.equal(count(db, 'bounce_streaks'), 0);
});

test('暫時性退信：中間有送達就從頭算；沒有期別的不計入；門檻可調；永久退信與檢舉清掉紀錄', async () => {
  const { db } = await setup();
  const soft = (email: string, campaign: string | null, opts = {}) => applyFeedback(db, { type: 'bounce', kind: 'transient', email, campaign, source: 'ses' }, opts);
  await soft('a@example.com', 'weekly-1');
  await soft('a@example.com', 'weekly-2');
  assert.equal(await applyFeedback(db, { type: 'delivery', email: 'a@example.com' }), 'delivery');
  assert.equal(count(db, 'bounce_streaks'), 0);
  assert.equal(await soft('a@example.com', 'weekly-3'), 'transient_counted');
  assert.equal(await soft('a@example.com', null), 'transient_no_campaign');
  assert.equal(await soft('a@example.com', 'bad id!'), 'transient_no_campaign');
  assert.equal(count(db, 'bounce_streaks'), 1);
  // 別人的紀錄互不影響；門檻 2
  assert.equal(await soft('b@example.com', 'weekly-1', { transientLimit: 2 }), 'transient_counted');
  assert.equal(await soft('b@example.com', 'weekly-2', { transientLimit: 2 }), 'transient_promoted');
  assert.equal(await suppressedReason(db, 'a@example.com', 'marketing'), null);
  // 永久退信後紀錄清掉
  await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: 'a@example.com', source: 'ses' });
  assert.equal(count(db, 'bounce_streaks', "email = 'a@example.com'"), 0);
});

test('壞輸入：信箱不合格、事件類型不認得 → rejected，不寫東西', async () => {
  const { db } = await setup();
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'nope', source: 'ses' }), 'rejected');
  assert.equal(await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: undefined as never, source: 'ses' }), 'rejected');
  assert.equal(await applyFeedback(db, { type: 'weird', email: 'a@example.com' } as never), 'rejected');
  assert.equal(count(db, 'suppressions'), 0);
});

test('成員清單的 suppressed 欄與 listStatus 同口徑：訂閱中但在全域拒收＝true／blocked', async () => {
  const { db } = await setup();
  await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: 'a@example.com', source: 'ses' });
  const page = (await listMembers(db, { list: 'weekly' })) as { members: Array<{ email: string; status: string; suppressed: boolean }> };
  const byEmail = Object.fromEntries(page.members.map((m) => [m.email, m]));
  assert.equal(byEmail['a@example.com'].suppressed, true);
  assert.equal(byEmail['b@example.com'].suppressed, false);
  assert.equal(await listStatus(db, { list: 'weekly', email: 'a@example.com' }), 'blocked');
  assert.equal(await listStatus(db, { list: 'weekly', email: 'b@example.com' }), 'subscribed');
  // 已退訂又在拒收：status 是 unsubscribed、suppressed 仍是 true（listStatus 以退訂為先）
  await applyFeedback(db, { type: 'complaint', email: 'b@example.com', source: 'ses' });
  const again = (await listMembers(db, { list: 'weekly' })) as { members: Array<{ email: string; status: string; suppressed: boolean }> };
  const b = again.members.find((m) => m.email === 'b@example.com')!;
  assert.deepEqual([b.status, b.suppressed], ['unsubscribed', true]);
});
