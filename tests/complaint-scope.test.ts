// A complaint about a newsletter stops newsletters only; a complaint about transactional mail and a hard bounce stop everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld } from './broadcast-helpers.ts';
import { fakeFetch, memoryDb } from './helpers.ts';
import { addSuppression, send, suppressedReason, type SendRequest } from '../src/core.ts';
import { applyFeedback } from '../src/feedback.ts';
import { importMembers, listStatus, listSubscribe, listMembers } from '../src/lists.ts';
import { consumeWelcome, saveWelcome } from '../src/welcome.ts';

const signIn = (to: string): SendRequest => ({ site: 'id', key: `login-${to}`, kind: 'login', from: 'Sign in <id@notify.example.com>', to, subject: 'Your sign-in link', html: '<p>link</p>', text: 'link' });
const sendTx = (db: Parameters<typeof send>[0]['db'], to: string) => send({ db, keys: { resend: 're_k', smtp2go: 's_k' }, fromDomain: 'notify.example.com', fetcher: fakeFetch({}) }, signIn(to));

test('simulator path: a newsletter complaint stops newsletters, re-joins, imports and welcome mail, but not sign-in mail', async () => {
  // The fake postman behaves like the provider's mailbox simulator: an address containing "complaint" is delivered, then complains.
  const w = await makeWorld({ members: 3, emailOf: (i) => (i === 0 ? 'complaint@simulator.example.com' : `r${i}@example.com`) });
  await w.campaign('weekly-1');
  await w.run(5);
  w.clock.t += 60_000;
  await w.flushEvents();
  const who = 'complaint@simulator.example.com';
  assert.equal(await suppressedReason(w.db as never, who, 'marketing'), 'unsubscribe');
  assert.equal(await suppressedReason(w.db as never, who, 'transactional'), null);

  // Transactional mail still goes out.
  assert.equal((await sendTx(w.db as never, who)).status, 'sent');

  // The member is unsubscribed everywhere; status for the member centre is unchanged in meaning (unsubscribed, suppressed).
  assert.equal(await listStatus(w.db, { list: 'weekly', email: who }), 'unsubscribed');
  const page = await listMembers(w.db, { list: 'weekly' });
  const row = 'members' in page ? page.members.find((m) => m.email === who) : undefined;
  assert.equal(row?.status, 'unsubscribed');
  assert.equal(row?.suppressed, true);

  // Re-joining by the person, imports and the next issue are all refused.
  assert.deepEqual(await listSubscribe(w.db, { list: 'weekly', email: who }, w.now), { status: 'blocked' });
  const imp = await importMembers(w.db, 'weekly', [{ email: who, status: 'subscribed' }], { importedFrom: 'previous-provider' }, w.now);
  assert.equal(imp.ok, true);
  assert.equal(await listStatus(w.db, { list: 'weekly', email: who }), 'unsubscribed', 'import did not re-subscribe');
  const before = w.postman.accepted.filter((m) => m.to === who).length;
  await w.campaign('weekly-2');
  await w.run(5);
  assert.equal(w.postman.accepted.filter((m) => m.to === who).length, before, 'no newsletter after the complaint');

  // Welcome mail: even forced through the queue, it is not sent.
  await saveWelcome(w.db as never, 'weekly', { subject: 'Hi', from: 'Weekly <news@mail.example.com>', html: '{{unsubscribe_url}}', text: '{{unsubscribe_url}}', webUrl: 'https://example.com/a', enabled: true }, { marketingDomain: 'mail.example.com', now: w.now });
  const contact = (await w.db.prepare('SELECT id FROM contacts WHERE email = ?').bind(who).first<{ id: number }>())!.id;
  const r = await consumeWelcome({ db: w.db, postman: w.postman, domain: 'mail.example.com', site: 'newsletter', utcOffsetHours: 8, unsub: { secrets: ['unsub-secret-0123456789abcdef'], baseUrl: 'https://u.example.com' }, now: w.now }, { kind: 'welcome', list: 'weekly', contact, queuedAt: w.now().toISOString() });
  assert.notEqual(r.outcome, 'welcome_sent');
});

test('transactional complaint (default scope) still stops everything', async () => {
  const db = memoryDb();
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'tx@example.com', source: 'resend-webhook' }), 'complaint');
  assert.equal(await suppressedReason(db, 'tx@example.com', 'transactional'), 'complaint');
  assert.equal(await suppressedReason(db, 'tx@example.com', 'marketing'), 'complaint');
  assert.equal((await sendTx(db, 'tx@example.com')).status, 'suppressed');
});

test('marketing-scoped complaint through applyFeedback', async () => {
  const db = memoryDb();
  assert.equal(await applyFeedback(db, { type: 'complaint', email: 'nl@example.com', source: 'ses-event', detail: 'abuse', scope: 'marketing' }), 'complaint_marketing');
  assert.equal(await suppressedReason(db, 'nl@example.com', 'transactional'), null);
  assert.equal(await suppressedReason(db, 'nl@example.com', 'marketing'), 'unsubscribe');
  assert.equal((await sendTx(db, 'nl@example.com')).status, 'sent');
});

test('hard bounce stops both kinds of mail', async () => {
  const db = memoryDb();
  await applyFeedback(db, { type: 'bounce', kind: 'permanent', email: 'gone@example.com', source: 'ses-event' });
  assert.equal(await suppressedReason(db, 'gone@example.com', 'transactional'), 'hard_bounce');
  assert.equal(await suppressedReason(db, 'gone@example.com', 'marketing'), 'hard_bounce');
  assert.equal((await sendTx(db, 'gone@example.com')).status, 'suppressed');
});

test('existing complaint rows keep stopping everything (no data change needed)', async () => {
  const db = memoryDb();
  await addSuppression(db, 'old@example.com', 'complaint', 'resend-webhook', null);
  assert.equal((await sendTx(db, 'old@example.com')).status, 'suppressed');
  // A later newsletter complaint does not weaken it.
  await applyFeedback(db, { type: 'complaint', email: 'old@example.com', source: 'ses-event', scope: 'marketing' });
  assert.equal(await suppressedReason(db, 'old@example.com', 'transactional'), 'complaint');
});
