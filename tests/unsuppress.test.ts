import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addSuppression, removeSuppression, suppressedReason } from '../src/core.ts';
import { memoryDb } from './helpers.ts';

test('人工解除拒收：只拿掉指定的原因，其他原因照擋', async () => {
  const db = memoryDb();
  await addSuppression(db, 'A@Example.com', 'hard_bounce', 'resend-webhook', null);
  await addSuppression(db, 'a@example.com', 'complaint', 'resend-webhook', null);
  assert.deepEqual(await removeSuppression(db, ' a@EXAMPLE.com ', ['hard_bounce']), ['hard_bounce']);
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), 'complaint');
  assert.deepEqual(await removeSuppression(db, 'a@example.com', ['complaint', 'unsubscribe']), ['complaint']);
  assert.equal(await suppressedReason(db, 'a@example.com', 'transactional'), null);
});

test('人工解除拒收：不在名單上＝回空陣列，不報錯', async () => {
  const db = memoryDb();
  assert.deepEqual(await removeSuppression(db, 'nobody@example.com', ['hard_bounce']), []);
});
