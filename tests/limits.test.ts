import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodySizeProblem, limitVar, localDay } from '../src/core.ts';

test('limitVar：只收 ≥0 的整數；其他一律用預設；明寫 0＝不限', () => {
  assert.equal(limitVar(undefined, 60), 60);
  assert.equal(limitVar('', 60), 60);
  assert.equal(limitVar(' ', 60), 60);
  assert.equal(limitVar(null, 60), 60);
  assert.equal(limitVar(true, 60), 60);
  assert.equal(limitVar('0.5', 60), 60);
  assert.equal(limitVar(-1, 60), 60);
  assert.equal(limitVar('abc', 60), 60);
  assert.equal(limitVar('0', 60), 0);
  assert.equal(limitVar(0, 60), 0);
  assert.equal(limitVar(' 120 ', 60), 120);
  assert.equal(limitVar(30, 60), 30);
});

test('bodySizeProblem：沒帶或亂碼＝missing；超過＝too_large', () => {
  assert.equal(bodySizeProblem(null, 100), 'missing');
  assert.equal(bodySizeProblem('abc', 100), 'missing');
  assert.equal(bodySizeProblem('-5', 100), 'missing');
  assert.equal(bodySizeProblem('101', 100), 'too_large');
  assert.equal(bodySizeProblem('100', 100), null);
  assert.equal(bodySizeProblem('0', 100), null);
});

test('localDay：預設 UTC；時差夾在 ±14；不合法＝UTC', () => {
  const t = new Date('2026-01-01T20:00:00Z');
  assert.equal(localDay(t), '2026-01-01');
  assert.equal(localDay(t, 8), '2026-01-02');
  assert.equal(localDay(t, -30), localDay(t, -14));
  assert.equal(localDay(t, 1e20), localDay(t, 14));
  assert.equal(localDay(t, 'x'), '2026-01-01');
  assert.equal(localDay(t, '8'), '2026-01-02');
  assert.equal(localDay(t, Number.NaN), '2026-01-01');
});
