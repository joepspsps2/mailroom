import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeLists, MAX_LIST_BYTES } from '../src/list-routes.ts';
import { count, listDb } from './lists-helpers.ts';

const TOKEN = 'admin-token-for-tests';
const call = (db: ReturnType<typeof listDb>, method: string, path: string, opts: { token?: string | null; body?: string; length?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  if (opts.length !== null && opts.body !== undefined) headers['content-length'] = opts.length ?? String(new TextEncoder().encode(opts.body).length);
  return routeLists(new Request(`https://mailroom.example.com${path}`, { method, headers, body: opts.body }), db, TOKEN);
};
const bodyOf = async (r: Response | null) => (await r!.json()) as Record<string, unknown>;

test('路徑不是名單管理入口＝回 null（交給後面的路由）', async () => {
  const db = listDb();
  assert.equal(await call(db, 'PUT', '/v1/send', { body: '{}' }), null);
  assert.equal(await call(db, 'PUT', '/v1/lists/Bad_Id', { body: '{}' }), null);
  assert.equal(await call(db, 'PUT', '/v1/lists/weekly/other', { body: '{}' }), null);
});

test('缺口令、錯口令、沒設口令：一律 404（不透露入口存在）', async () => {
  const db = listDb();
  for (const token of [null, 'wrong-token', '']) assert.equal((await call(db, 'PUT', '/v1/lists/weekly', { token, body: '{"name":"W"}' }))!.status, 404);
  const none = await routeLists(new Request('https://mailroom.example.com/v1/lists/weekly', { method: 'PUT', headers: { authorization: 'Bearer ', 'content-length': '2' }, body: '{}' }), db, undefined);
  assert.equal(none!.status, 404);
  assert.equal(count(db, 'lists'), 0);
});

test('方法不對：PUT 路徑只收 PUT、import／segments 只收 POST，其他 404', async () => {
  const db = listDb();
  assert.equal((await call(db, 'POST', '/v1/lists/weekly', { body: '{"name":"W"}' }))!.status, 404);
  assert.equal((await call(db, 'GET', '/v1/lists/weekly'))!.status, 404);
  assert.equal((await call(db, 'PUT', '/v1/lists/weekly/import', { body: '{}' }))!.status, 404);
  assert.equal((await call(db, 'GET', '/v1/lists/weekly/segments'))!.status, 404);
});

test('內文：沒帶長度 411、太大 413、壞 JSON 400、不是物件 400', async () => {
  const db = listDb();
  const noLen = await call(db, 'PUT', '/v1/lists/weekly', { body: '{"name":"W"}', length: null });
  assert.equal(noLen!.status, 411);
  assert.equal((await bodyOf(noLen)).reason, 'length_required');
  const big = await call(db, 'PUT', '/v1/lists/weekly', { body: '{}', length: String(MAX_LIST_BYTES + 1) });
  assert.equal(big!.status, 413);
  assert.equal((await bodyOf(big)).reason, 'too_large');
  for (const body of ['{not json', '', 'null', '[]', '"str"', '42']) {
    const r = await call(db, 'PUT', '/v1/lists/weekly', { body });
    assert.equal(r!.status, 400, body);
    assert.equal((await bodyOf(r)).reason, 'bad_json', body);
  }
  assert.equal(count(db, 'lists'), 0);
});

test('建立名單、匯入、分群：成功與業務錯誤對應的狀態碼', async () => {
  const db = listDb();
  assert.equal((await call(db, 'PUT', '/v1/lists/weekly', { body: JSON.stringify({ name: 'Weekly' }) }))!.status, 200);
  assert.equal((await call(db, 'PUT', '/v1/lists/weekly', { body: JSON.stringify({ name: ' ' }) }))!.status, 400);
  const imp = await call(db, 'POST', '/v1/lists/weekly/import', { body: JSON.stringify({ importedFrom: 'src', rows: [{ email: 'a@example.com', status: 'subscribed' }] }) });
  assert.equal(imp!.status, 200);
  assert.equal(count(db, 'list_members'), 1);
  assert.equal((await call(db, 'POST', '/v1/lists/nope/import', { body: JSON.stringify({ importedFrom: 'src', rows: [] }) }))!.status, 400);
  const seg = await call(db, 'POST', '/v1/lists/weekly/segments', { body: JSON.stringify({ items: [{ email: 'a@example.com', segment: 'G1' }] }) });
  assert.equal((await bodyOf(seg)).updated, 1);
  assert.equal((await call(db, 'POST', '/v1/lists/weekly/segments', { body: JSON.stringify({ items: 'x' }) }))!.status, 400);
});

test('匯入的 expected 不是物件（字串、陣列、null）→ 400，什麼都不寫', async () => {
  const db = listDb();
  await call(db, 'PUT', '/v1/lists/weekly', { body: JSON.stringify({ name: 'Weekly' }) });
  for (const expected of ['subscribed', ['subscribed'], null, 5]) {
    const r = await call(db, 'POST', '/v1/lists/weekly/import', { body: JSON.stringify({ importedFrom: 'src', rows: [{ email: 'a@example.com', status: 'subscribed' }], expected }) });
    assert.equal(r!.status, 400, JSON.stringify(expected));
    assert.equal((await bodyOf(r)).reason, 'bad_body');
  }
  assert.equal(count(db, 'list_members'), 0);
  const ok = await call(db, 'POST', '/v1/lists/weekly/import', { body: JSON.stringify({ importedFrom: 'src', rows: [{ email: 'a@example.com', status: 'subscribed' }], expected: { subscribed: 2 } }) });
  assert.equal((await bodyOf(ok)).reason, 'count_mismatch');
});

test('管理口令入口有速度上限：超過回 429', async () => {
  const db = listDb();
  let last: Response | null = null;
  for (let i = 0; i < 21; i++) last = await call(db, 'PUT', '/v1/lists/weekly', { body: JSON.stringify({ name: 'W' }) });
  assert.equal(last!.status, 429);
  assert.ok(last!.headers.get('retry-after'));
});
