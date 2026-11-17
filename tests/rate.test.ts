import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pruneRate, takeRate } from '../src/core.ts';
import { memoryDb } from './helpers.ts';

const t0 = new Date('2026-11-16T10:00:05Z');

test('速度上限：每分鐘第 N+1 次起擋；別站不互相影響；下一分鐘重算', async () => {
  const db = memoryDb();
  const lim = { perMinute: 3, perDay: 100 };
  for (let i = 0; i < 3; i++) assert.equal(await takeRate(db, 'shop', lim, t0), null);
  assert.equal(await takeRate(db, 'shop', lim, t0), 'minute');
  assert.equal(await takeRate(db, 'other', lim, t0), null);
  assert.equal(await takeRate(db, 'shop', lim, new Date(t0.getTime() + 60_000)), null);
});

test('速度上限：每天上限跨分鐘累計', async () => {
  const db = memoryDb();
  const lim = { perMinute: 100, perDay: 2 };
  assert.equal(await takeRate(db, 'shop', lim, t0), null);
  assert.equal(await takeRate(db, 'shop', lim, new Date(t0.getTime() + 120_000)), null);
  assert.equal(await takeRate(db, 'shop', lim, new Date(t0.getTime() + 240_000)), 'day');
});

test('速度上限：同時打進來也不會超過（計數是原子的）', async () => {
  const db = memoryDb();
  const lim = { perMinute: 5, perDay: 0 };
  const results = await Promise.all(Array.from({ length: 12 }, () => takeRate(db, 'shop', lim, t0)));
  assert.equal(results.filter((r) => r === null).length, 5);
});

test('速度上限：0 或不合法＝不限；舊計數窗會清掉', async () => {
  const db = memoryDb();
  assert.equal(await takeRate(db, 'shop', { perMinute: 0, perDay: Number.NaN }, t0), null);
  await takeRate(db, 'shop', { perMinute: 10, perDay: 10 }, t0);
  await pruneRate(db, new Date(t0.getTime() + 3 * 86_400_000));
  assert.equal((db.raw.prepare('SELECT COUNT(*) AS n FROM rate_counters').get() as { n: number }).n, 0);
});
