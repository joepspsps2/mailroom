import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, DOMAIN } from './broadcast-helpers.ts';
import { addSuppression } from '../src/core.ts';
import { importMembers, listSubscribe, listUnsubscribe } from '../src/lists.ts';
import { checkWelcome, consumeWelcome, getWelcome, saveWelcome, subscribeWithWelcome, WELCOME_MAX_AGE_MS, type WelcomeInput, type WelcomeMessage } from '../src/welcome.ts';
import { routeLists } from '../src/list-routes.ts';

const SECRET = 'unsub-secret-0123456789abcdef';
const WELCOME: WelcomeInput = {
  subject: 'Welcome to Example Weekly',
  from: `Example Weekly <news@${DOMAIN}>`,
  html: '<p>{{#name}}Hi {{name}},{{/name}} thanks for subscribing.</p><p><a href="{{web_url}}">Past issues</a> · <a href="{{unsubscribe_url}}">Unsubscribe</a></p>',
  text: '{{#name}}Hi {{name}},{{/name}} thanks for subscribing.\nPast issues: {{web_url}}\nUnsubscribe: {{unsubscribe_url}}',
  webUrl: 'https://www.example.com/archive',
  enabled: true,
};

async function world(opts: { enabled?: boolean; switchOn?: boolean } = {}) {
  const w = await makeWorld({ members: 0 });
  w.deps.unsub = { secrets: [SECRET], baseUrl: 'https://u.example.com' };
  // The tick creates today's throttle row (provider limits read), like the scheduled handler does every minute.
  await w.run(1);
  const saved = await saveWelcome(w.db as never, 'weekly', { ...WELCOME, enabled: opts.enabled ?? true }, { marketingDomain: DOMAIN, now: w.now });
  assert.equal(saved.ok, true);
  const queue = { send: async (body: WelcomeMessage, o?: { delaySeconds?: number }) => void w.queue.push({ body, availableAt: w.clock.t + (o?.delaySeconds ?? 0) * 1000, tries: 0 }) };
  const subscribe = (email: string, name?: string) => subscribeWithWelcome(w.db, { list: 'weekly', email, source: 'test', ...(name ? { name } : {}) }, { queue, switchOn: opts.switchOn ?? true, now: w.now });
  const settle = async () => {
    w.clock.t += 10_000;
    await w.drain();
  };
  const welcomes = () => w.postman.accepted.filter((m) => m.tags.campaign === '_welcome-weekly');
  return { ...w, subscribe, settle, welcomes, queueAdapter: queue };
}

test('a first-time subscriber gets one welcome mail with unsubscribe link and headers, on the newsletter domain', async () => {
  const w = await world();
  assert.deepEqual(await w.subscribe('new@example.com', 'Ada'), { status: 'subscribed', firstTime: true });
  await w.settle();
  const [m] = w.welcomes();
  assert.ok(m);
  assert.equal(m.to, 'new@example.com');
  assert.match(m.from, new RegExp(`@${DOMAIN.replace(/\./g, '\\.')}>$`));
  assert.match(m.html, /Hi Ada,/);
  assert.match(m.html, /https:\/\/u\.example\.com\/u\//);
  assert.match(m.text, /Unsubscribe: https:\/\/u\.example\.com\/u\//);
  assert.match(m.headers?.['List-Unsubscribe'] ?? '', /^<https:\/\/u\.example\.com\/u\/[^>]+>$/);
  assert.equal(m.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.doesNotMatch(m.html + m.text, /\{\{/);
  const row = (await w.db.prepare("SELECT status, kind, stream, dedupe_key FROM messages WHERE kind = 'welcome'").first()) as Record<string, string>;
  assert.deepEqual({ ...row }, { status: 'sent', kind: 'welcome', stream: 'marketing', dedupe_key: 'welcome:weekly:1' });
});

test('no name: the greeting section is dropped', async () => {
  const w = await world();
  await w.subscribe('anon@example.com');
  await w.settle();
  assert.doesNotMatch(w.welcomes()[0].html, /Hi /);
});

test('master switch off: nothing is queued or sent', async () => {
  const w = await world({ switchOn: false });
  assert.deepEqual(await w.subscribe('new@example.com'), { status: 'subscribed', firstTime: true });
  assert.equal(w.queue.length, 0);
  await w.settle();
  assert.equal(w.welcomes().length, 0);
});

test('welcome mail not enabled for the list: nothing is queued; a disable after queueing stops the send', async () => {
  const w = await world({ enabled: false });
  await w.subscribe('new@example.com');
  assert.equal(w.queue.length, 0);
  // Enabled, queued, then disabled before the queue runs.
  await saveWelcome(w.db as never, 'weekly', { ...WELCOME, enabled: true }, { marketingDomain: DOMAIN, now: w.now });
  await w.subscribe('second@example.com');
  assert.equal(w.queue.length, 1);
  await saveWelcome(w.db as never, 'weekly', { ...WELCOME, enabled: false }, { marketingDomain: DOMAIN, now: w.now });
  await w.settle();
  assert.equal(w.welcomes().length, 0);
});

test('subscribing again, unsubscribing and re-subscribing never sends a second welcome', async () => {
  const w = await world();
  await w.subscribe('a@example.com');
  assert.deepEqual(await w.subscribe('a@example.com'), { status: 'already' });
  await w.settle();
  assert.equal(w.welcomes().length, 1);
  await listUnsubscribe(w.db, { list: 'weekly', email: 'a@example.com', source: 'link' }, w.now);
  assert.deepEqual(await w.subscribe('a@example.com'), { status: 'subscribed', firstTime: false });
  await w.settle();
  assert.equal(w.welcomes().length, 1);
});

test('duplicate queue messages and concurrent subscribes still send one mail (ledger key)', async () => {
  const w = await world();
  await w.subscribe('a@example.com');
  w.queue.push({ ...w.queue[0] });
  w.queue.push({ ...w.queue[0] });
  w.clock.t += 10_000;
  await w.drain({ duplicate: true });
  assert.equal(w.welcomes().length, 1);
});

test('blocked (suppressed) addresses are not added and get no welcome; suppression after queueing also stops it', async () => {
  const w = await world();
  await addSuppression(w.db as never, 'bounced@example.com', 'hard_bounce', 'test', null);
  assert.deepEqual(await w.subscribe('bounced@example.com'), { status: 'blocked' });
  await w.subscribe('later@example.com');
  await addSuppression(w.db as never, 'later@example.com', 'complaint', 'test', null);
  await w.settle();
  assert.equal(w.welcomes().length, 0);
});

test('unsubscribed before the queue runs: no welcome', async () => {
  const w = await world();
  await w.subscribe('quick@example.com');
  await listUnsubscribe(w.db, { list: 'weekly', email: 'quick@example.com', source: 'api' }, w.now);
  await w.settle();
  assert.equal(w.welcomes().length, 0);
});

test('imports (migration) never trigger a welcome, and an imported person who subscribes later is not first-time', async () => {
  const w = await world();
  const r = await importMembers(w.db, 'weekly', [{ email: 'old@example.com', status: 'subscribed' }, { email: 'gone@example.com', status: 'unsubscribed' }], { importedFrom: 'previous-provider' }, w.now);
  assert.equal(r.ok, true);
  assert.equal(w.queue.length, 0);
  assert.deepEqual(await w.subscribe('old@example.com'), { status: 'already' });
  assert.deepEqual(await w.subscribe('gone@example.com'), { status: 'subscribed', firstTime: false });
  await w.settle();
  assert.equal(w.welcomes().length, 0);
});

test('plain listSubscribe (no welcome wiring) reports firstTime too', async () => {
  const w = await world();
  assert.deepEqual(await listSubscribe(w.db, { list: 'weekly', email: 'p@example.com' }, w.now), { status: 'subscribed', firstTime: true });
  assert.equal(w.queue.length, 0);
});

test('domain hold: waits and retries; gives up after the maximum age', async () => {
  const w = await world();
  await w.db.prepare('INSERT INTO domain_holds (domain, reason, created_at) VALUES (?, ?, ?)').bind(DOMAIN, 'test', w.now().toISOString()).run();
  await w.subscribe('held@example.com');
  await w.settle();
  assert.equal(w.welcomes().length, 0);
  assert.equal(w.queue.length, 1, 'retried later');
  const msg = w.queue[0].body as WelcomeMessage;
  const deps = { db: w.db, postman: w.postman, domain: DOMAIN, site: 'newsletter', utcOffsetHours: 8, unsub: w.deps.unsub! };
  const expired = await consumeWelcome({ ...deps, now: () => new Date(Date.parse(msg.queuedAt) + WELCOME_MAX_AGE_MS + 1) }, msg);
  assert.equal(expired.action, 'ack');
  assert.match(expired.outcome, /^welcome_expired/);
});

test('no unsubscribe configuration: nothing is sent', async () => {
  const w = await world();
  w.deps.unsub = { secrets: [] };
  await w.subscribe('x@example.com');
  await w.settle();
  assert.equal(w.welcomes().length, 0);
  assert.equal(await w.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'welcome'").first().then((r) => Number((r as { n: number }).n)), 0);
});

test('provider failure: temporary is retried, permanent is recorded once', async () => {
  const w = await world();
  const deps = { db: w.db, postman: w.postman, domain: DOMAIN, site: 'newsletter', utcOffsetHours: 8, unsub: w.deps.unsub!, now: w.now };
  await w.subscribe('t@example.com');
  const msg = w.queue.shift()!.body as WelcomeMessage;
  const send = w.postman.send.bind(w.postman);
  let calls = 0;
  w.postman.send = async (m) => (++calls === 1 ? { ok: false, kind: 'temporary', error: 'busy' } : send(m));
  const first = await consumeWelcome(deps, msg);
  assert.equal(first.action, 'retry');
  const second = await consumeWelcome(deps, msg);
  assert.deepEqual(second, { action: 'ack', outcome: 'welcome_sent' });
  await w.subscribe('p@example.com');
  const msg2 = w.queue.shift()!.body as WelcomeMessage;
  w.postman.send = async () => ({ ok: false, kind: 'permanent', error: 'rejected' });
  assert.deepEqual(await consumeWelcome(deps, msg2), { action: 'ack', outcome: 'welcome_failed_permanent' });
});

test('checkWelcome refuses missing unsubscribe link, tracking placeholders, wrong sender, implicit enable', () => {
  assert.equal(checkWelcome(WELCOME, DOMAIN), null);
  assert.equal(checkWelcome({ ...WELCOME, text: 'no link' }, DOMAIN), 'unsubscribe_link_missing');
  assert.equal(checkWelcome({ ...WELCOME, html: WELCOME.html + '<img src="https://t.example.com/o/{{o}}.gif">' }, DOMAIN), 'tracking_not_supported');
  assert.equal(checkWelcome({ ...WELCOME, html: WELCOME.html + '{{shoe_size}}' }, DOMAIN), 'unknown_placeholder');
  assert.equal(checkWelcome({ ...WELCOME, from: 'news@other.example.com' }, DOMAIN), 'bad_from');
  assert.equal(checkWelcome({ ...WELCOME, enabled: undefined as never }, DOMAIN), 'enabled_required');
  assert.equal(checkWelcome({ ...WELCOME, webUrl: 'http://example.com' }, DOMAIN), 'bad_web_url');
});

test('admin route: PUT saves, GET reads, both need the token; no marketing domain = refused', async () => {
  const w = await world();
  const req = (method: string, body?: unknown, token = 'admin-token') =>
    new Request('https://mailroom.example.com/v1/lists/weekly/welcome', { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json', 'content-length': String(JSON.stringify(body).length) } : {}) }, body: body ? JSON.stringify(body) : undefined });
  assert.equal((await routeLists(req('GET', undefined, 'wrong'), w.db as never, 'admin-token', DOMAIN))!.status, 404);
  const put = (await routeLists(req('PUT', { ...WELCOME, subject: 'Hello', enabled: false }), w.db as never, 'admin-token', DOMAIN))!;
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { ok: true, enabled: false, changed: true });
  const got = (await (await routeLists(req('GET'), w.db as never, 'admin-token', DOMAIN))!.json()) as Record<string, unknown>;
  assert.equal(got.subject, 'Hello');
  assert.equal(got.enabled, false);
  assert.equal((await routeLists(req('PUT', WELCOME), w.db as never, 'admin-token', undefined))!.status, 400);
  assert.equal((await getWelcome(w.db as never, 'weekly'))!.enabled, 0);
});

test('desk command: welcome dry run, refuses without --enable/--disable, stores, shows status', async () => {
  const { runCli } = await import('../src/cli/main.ts');
  const w = await world({ enabled: false });
  const BASE = 'https://mailroom.example.com';
  const fetchFn = (async (url: string, init?: RequestInit) => {
    if (url.startsWith(BASE)) {
      const body = init?.body ? String(init.body) : undefined;
      const headers = { ...(init?.headers as Record<string, string>), ...(body ? { 'content-length': String(new TextEncoder().encode(body).length) } : {}) };
      return (await routeLists(new Request(url, { method: init?.method, headers, body }), w.db as never, 'secret', DOMAIN)) ?? new Response('not found', { status: 404 });
    }
    return new Response('', { status: 200 });
  }) as typeof fetch;
  const source = '---\ntitle: Welcome aboard\ndescription: What to expect\n---\n\nThanks for subscribing. See the [archive](https://example.com/archive).\n';
  const run = async (args: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, {
      defaults: { baseUrl: BASE, list: 'weekly', from: `Weekly <news@${DOMAIN}>`, template: { brandName: 'Example Weekly', postalAddress: '1 Example Street, Sample City 00000' }, composeDefaults: { trackBase: 'https://t.example.com' } },
      env: { MAILROOM_ADMIN_TOKEN: 'secret' },
      io: { out: (s) => out.push(s), err: (s) => err.push(s), fetch: fetchFn, readFile: async () => source, writeFile: async () => {}, now: w.now },
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const dry = await run(['welcome', '--source', 'w.md', '--web-url', 'https://example.com/archive']);
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /DRY RUN/);
  assert.match(dry.out, /not tracked/);
  const noFlag = await run(['welcome', '--source', 'w.md', '--web-url', 'https://example.com/archive', '--yes']);
  assert.equal(noFlag.code, 2);
  const stored = await run(['welcome', '--source', 'w.md', '--web-url', 'https://example.com/archive', '--enable', '--yes']);
  assert.equal(stored.code, 0, stored.err + stored.out);
  const row = (await getWelcome(w.db as never, 'weekly'))!;
  assert.equal(row.subject, 'Welcome aboard');
  assert.equal(row.enabled, 1);
  assert.doesNotMatch(row.html, /\{\{c:|\{\{o\}\}/, 'no tracking in welcome mail');
  const shown = await run(['welcome']);
  assert.match(shown.out, /welcome mail is ON/);
});
