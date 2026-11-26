// 分析匯出：授權、分頁、重拉不重複、ack 冪等、中途失敗從 cursor 續傳、不含信箱。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFixture, exportCall, TOKEN } from './export-fixture.ts';

const lines = async (r: Response | null) => {
  const t = (await r!.text()).trim();
  return t ? t.split('\n').map((l) => JSON.parse(l) as Record<string, any>) : [];
};

async function pullAll(f: Awaited<ReturnType<typeof buildFixture>>, path: string, limit: number, fromCursor = '') {
  const rows: Record<string, any>[] = [];
  let cursor = fromCursor;
  for (let guard = 0; guard < 10_000; guard++) {
    const r = (await exportCall(f.w, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=${limit}&cursor=${cursor}`))!;
    assert.equal(r.status, 200);
    const page = await lines(r);
    assert.equal(Number(r.headers.get('x-export-count')), page.length);
    rows.push(...page);
    cursor = r.headers.get('x-export-next-cursor') ?? '';
    if (r.headers.get('x-export-has-more') !== '1') return rows;
  }
  throw new Error('paging did not end');
}

test('授權與路徑：缺口令／錯口令／方法不對一律 404；不是匯出路徑回 null', async () => {
  const f = await buildFixture({ members: 8, issues: 1 });
  for (const token of [null, 'wrong', '']) assert.equal((await exportCall(f.w, 'GET', '/v1/export/events', { token }))!.status, 404);
  assert.equal((await exportCall(f.w, 'POST', '/v1/export/events'))!.status, 404);
  assert.equal((await exportCall(f.w, 'GET', '/v1/export/events/ack'))!.status, 404);
  assert.equal(await exportCall(f.w, 'GET', '/v1/export/other'), null);
  assert.equal(await exportCall(f.w, 'GET', '/v1/send'), null);
  assert.equal((await exportCall(f.w, 'GET', '/v1/export/events?cursor=abc'))!.status, 400);
  assert.equal((await exportCall(f.w, 'GET', '/v1/export/recipients'))!.status, 400);
  assert.equal((await exportCall(f.w, 'GET', '/v1/export/members?list=Bad_Id'))!.status, 400);
  assert.ok(TOKEN.length > 10);
});

test('事件：不同頁大小拉到的內容完全一樣、依 id 遞增、不含信箱', async () => {
  const f = await buildFixture({ members: 30, issues: 2 });
  const all = await pullAll(f, '/v1/export/events', 5000);
  const small = await pullAll(f, '/v1/export/events', 7);
  assert.ok(all.length > 150);
  assert.deepEqual(small, all);
  assert.deepEqual(all.map((e) => e.id), [...all.map((e) => e.id)].sort((a, b) => a - b));
  assert.equal(new Set(all.map((e) => e.id)).size, all.length);
  assert.equal(new Set(all.map((e) => e.provider_event_id)).size, all.length);
  for (const e of all) {
    assert.equal(JSON.stringify(e).includes('@'), false, '事件不得帶信箱');
    assert.ok(['send', 'delivery', 'bounce', 'complaint', 'reject', 'delay', 'open', 'click', 'unsubscribe'].includes(e.type));
  }
  const types = new Set(all.map((e) => e.type));
  for (const t of ['send', 'delivery', 'bounce', 'complaint', 'open', 'click', 'unsubscribe']) assert.ok(types.has(t), `缺 ${t}`);
  const click = all.find((e) => e.type === 'click' && e.detail?.suspect === 'scanner');
  assert.ok(click, '要有被標假點擊的事件');
  assert.ok(all.some((e) => e.type === 'open' && String(e.detail?.ua).includes('Apple')));
});

test('重拉不重複、新事件只在後面；中途失敗從上次存好的 cursor 續傳不漏不重', async () => {
  const f = await buildFixture({ members: 30, issues: 1 });
  const first = (await exportCall(f.w, 'GET', '/v1/export/events?limit=40'))!;
  const p1 = await lines(first);
  const cursor = first.headers.get('x-export-next-cursor')!;
  assert.equal(p1.length, 40);
  // 同一個 cursor 重拉兩次，內容一樣（讀取不改狀態）
  const a = await lines(await exportCall(f.w, 'GET', `/v1/export/events?limit=40&cursor=${cursor}`));
  const b = await lines(await exportCall(f.w, 'GET', `/v1/export/events?limit=40&cursor=${cursor}`));
  assert.deepEqual(a, b);
  // 「第二頁拿到一半失敗」＝分析端沒存好，從 cursor 再來：與一口氣拉到底的結果接得起來
  const resumed = [...p1, ...(await pullAll(f, '/v1/export/events', 40, cursor))];
  assert.deepEqual(resumed, await pullAll(f, '/v1/export/events', 5000));
  // 拉完之後又來新事件：從尾端 cursor 只拿到新的
  const last = resumed[resumed.length - 1].id;
  await f.w.db.prepare("INSERT INTO events (provider, provider_event_id, campaign_id, contact_id, type, at) VALUES ('self', 'late-1', 'weekly-163', 1, 'open', '2027-03-09T00:00:00.000Z')").run();
  const fresh = await pullAll(f, '/v1/export/events', 50, String(last));
  assert.deepEqual(fresh.map((e) => e.provider_event_id), ['late-1']);
});

test('ack：只標 id ≤ through、可重複執行、超過最大 id 或亂填被拒；標記不影響下次從哪拉', async () => {
  const f = await buildFixture({ members: 20, issues: 1 });
  const all = await pullAll(f, '/v1/export/events', 5000);
  assert.ok(all.every((e) => e.exported_at === null));
  const through = all[Math.floor(all.length / 2)].id;
  const r1 = (await exportCall(f.w, 'POST', '/v1/export/events/ack', { body: { through } }))!;
  assert.equal(r1.status, 200);
  const j1 = (await r1.json()) as { ok: boolean; marked: number };
  assert.equal(j1.marked, all.filter((e) => e.id <= through).length);
  const j2 = (await (await exportCall(f.w, 'POST', '/v1/export/events/ack', { body: { through } }))!.json()) as { marked: number };
  assert.equal(j2.marked, 0);
  const n = Number((f.w.db as any).raw.prepare('SELECT COUNT(*) AS n FROM events WHERE exported_at IS NOT NULL').get().n);
  assert.equal(n, j1.marked);
  const maxId = all[all.length - 1].id;
  assert.equal((await exportCall(f.w, 'POST', '/v1/export/events/ack', { body: { through: maxId + 1 } }))!.status, 400);
  for (const bad of [-1, 1.5, '5', null]) assert.equal((await exportCall(f.w, 'POST', '/v1/export/events/ack', { body: { through: bad } }))!.status, 400);
  // 標過的事件下次仍然拉得到（只是 exported_at 有值）
  const again = await pullAll(f, '/v1/export/events', 5000);
  assert.equal(again.length, all.length);
  assert.equal(again.filter((e) => e.exported_at !== null).length, j1.marked);
});

test('期別、凍結名單、成員：分頁拿到的就是整張表；凍結名單不含信箱、成員含信箱', async () => {
  const f = await buildFixture({ members: 30, issues: 2 });
  const camps = await pullAll(f, '/v1/export/campaigns', 1);
  assert.deepEqual(camps.map((c) => c.id), f.issues);
  assert.ok(camps.every((c) => c.status === 'done' && c.started_at && c.finished_at));
  const rec = await pullAll(f, `/v1/export/recipients?campaign=${f.issues[0]}`, 7);
  assert.equal(rec.length, 30);
  assert.equal(JSON.stringify(rec).includes('@'), false);
  assert.ok(rec.every((r) => ['活躍群', '觀察群', '沉睡群', '新進觀察群'].includes(r.segment)));
  const mem = await pullAll(f, '/v1/export/members?list=weekly', 11);
  assert.equal(mem.length, 30);
  assert.equal(new Set(mem.map((m) => m.email)).size, 30);
  assert.ok(mem.every((m) => m.email.endsWith('@example.com')));
  assert.equal(mem.filter((m) => m.status === 'unsubscribed').length >= 1, true);
});
