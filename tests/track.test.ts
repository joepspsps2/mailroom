import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDb } from './helpers.ts';
import {
  checkLinks, clearTrackCache, handleTrackRequest, resolveTrackSettings, signTrack, trackHost, trackSecrets, trackSigner, verifyTrack, type TrackDeps,
} from '../src/track.ts';
import { saveDraft } from '../src/broadcast/campaigns.ts';
import { personalizeRender, trackFromEnv } from '../src/broadcast/worker.ts';
import type { Db } from '../src/core.ts';

const SECRET = 'track-secret-0123456789abcdef';
const OLD = 'old-track-secret-0123456789';
const HOST = 't.example.com';
const T0 = Date.parse('2027-03-01T01:00:00.000Z');

function setup(opts: { links?: { index: number; url: string }[] | null } = {}) {
  clearTrackCache();
  const db = memoryDb();
  const iso = new Date(T0).toISOString();
  db.raw.exec(`INSERT INTO lists (id, name, created_at) VALUES ('weekly', 'Weekly', '${iso}')`);
  db.raw.exec(`INSERT INTO contacts (id, email, created_at, updated_at) VALUES (7, 'reader@example.com', '${iso}', '${iso}')`);
  db.raw.exec(`INSERT INTO list_members (list_id, contact_id, status, subscribed_at, updated_at) VALUES ('weekly', 7, 'subscribed', '${iso}', '${iso}')`);
  const links = opts.links === undefined ? [{ index: 1, url: 'https://example.com/a?utm_source=newsletter' }, { index: 2, url: 'https://example.com/b' }, { index: 3, url: 'https://example.com/c' }, { index: 4, url: 'https://example.com/d' }] : opts.links;
  db.raw.prepare(`INSERT INTO campaigns (id, list_id, subject, from_addr, html, text, status, audience, content_hash, links, created_at, updated_at) VALUES ('weekly-1', 'weekly', 's', 'n@mail.example.com', 'h', 't', 'sending', '{}', 'x', ?, ?, ?)`).run(links ? JSON.stringify(links) : null, iso, iso);
  db.raw.prepare(`INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, created_at, updated_at, sent_at) VALUES ('marketing', 'marketing', 'newsletter', 'c:weekly-1:7', 'newsletter', 'reader@example.com', 'n@mail.example.com', 's', 'sent', ?, ?, ?)`).run(iso, iso, iso);
  let now = T0 + 5 * 60_000; // five minutes after sending
  const deps: TrackDeps & { setNow: (ms: number) => void } = {
    db, secrets: [SECRET], host: HOST, settings: resolveTrackSettings(undefined), now: () => new Date(now),
    setNow: (ms: number) => { now = ms; },
  };
  return { db, deps };
}

function req(path: string, init: { method?: string; ua?: string; asn?: number; host?: string } = {}): Request {
  const r = new Request(`https://${init.host ?? HOST}${path}`, { method: init.method ?? 'GET', headers: init.ua ? { 'user-agent': init.ua } : {} });
  if (init.asn !== undefined) Object.defineProperty(r, 'cf', { value: { asn: init.asn } });
  return r;
}

const click = (contact: number, index: number, secret = SECRET, campaign = 'weekly-1') => signTrack(secret, { kind: 'c', campaign, contact, index });
const open = (contact: number, secret = SECRET) => signTrack(secret, { kind: 'o', campaign: 'weekly-1', contact, index: null });
const events = (db: ReturnType<typeof memoryDb>) => db.raw.prepare('SELECT * FROM events ORDER BY id').all() as Record<string, unknown>[];

beforeEach(() => clearTrackCache());

test('token round trip, rotation, and rejection of forged or altered tokens', async () => {
  const t = await click(7, 2);
  assert.deepEqual(await verifyTrack([SECRET], t, 'c'), { kind: 'c', campaign: 'weekly-1', contact: 7, index: 2 });
  assert.equal(await verifyTrack([SECRET], t, 'o'), null, 'a click token is not an open token');
  assert.equal(await verifyTrack(['another-secret-0123456789'], t, 'c'), null);
  const old = await click(7, 2, OLD);
  assert.ok(await verifyTrack(trackSecrets(SECRET, OLD), old, 'c'), 'previous secret still verifies');
  assert.equal(await verifyTrack(trackSecrets(SECRET), old, 'c'), null);
  // Change the payload but keep the signature: contact 7 -> 8, index 2 -> 3.
  const [, sig] = t.split('.');
  for (const payload of ['c|weekly-1|8|2', 'c|weekly-1|7|3', 'c|weekly-2|7|2']) {
    const forged = `${Buffer.from(payload).toString('base64url')}.${sig}`;
    assert.equal(await verifyTrack([SECRET], forged, 'c'), null, payload);
  }
  // Flip one signature character.
  const flipped = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
  assert.equal(await verifyTrack([SECRET], flipped, 'c'), null);
  for (const junk of ['', 'abc', 'a.b', `${t}x`, `${t}.x`, 'Yw.' + 'A'.repeat(22)]) assert.equal(await verifyTrack([SECRET], junk, 'c'), null, junk);
  assert.deepEqual(trackSecrets('short', undefined), [], 'secrets shorter than 16 characters are ignored');
  await assert.rejects(signTrack(SECRET, { kind: 'c', campaign: 'weekly-1', contact: 7, index: 0 }));
  await assert.rejects(signTrack(SECRET, { kind: 'c', campaign: 'Bad Id', contact: 7, index: 1 }));
});

test('click redirects to the campaign link and records an event without an address', async () => {
  const { db, deps } = setup();
  const res = (await handleTrackRequest(req(`/c/${await click(7, 1)}`, { ua: 'Mozilla/5.0 (Macintosh)' }), deps))!;
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/a?utm_source=newsletter');
  assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  const [ev] = events(db);
  assert.equal(ev.type, 'click');
  assert.equal(ev.provider, 'self');
  assert.equal(ev.campaign_id, 'weekly-1');
  assert.equal(ev.contact_id, 7);
  assert.equal(ev.message_id, 1);
  const detail = JSON.parse(String(ev.detail));
  assert.equal(detail.linkIndex, 1);
  assert.equal(detail.url, 'https://example.com/a?utm_source=newsletter');
  assert.equal(detail.suspect, undefined);
  assert.doesNotMatch(String(ev.detail), /reader@example\.com/);
  const m = db.raw.prepare('SELECT last_click_at FROM list_members WHERE contact_id = 7').get() as { last_click_at: string };
  assert.ok(m.last_click_at);
});

test('not an open redirect: forged, altered, unknown campaign or index all get the same 404 and no event', async () => {
  const { db, deps } = setup();
  const t = await click(7, 1);
  const cases = [
    `/c/${t.slice(0, -2)}AA`,
    `/c/${await click(7, 9)}`, // index not in the issue's link table
    `/c/${await click(7, 1, SECRET, 'weekly-99')}`, // campaign does not exist
    `/c/${await click(7, 1, 'attacker-secret-0123456789')}`,
    `/c/${encodeURIComponent('https://evil.example/')}`,
    `/c/x?url=https://evil.example/`,
  ];
  const bodies = new Set<string>();
  for (const path of cases) {
    const res = (await handleTrackRequest(req(path), deps))!;
    assert.equal(res.status, 404, path);
    assert.equal(res.headers.get('location'), null);
    bodies.add(await res.text());
  }
  assert.equal(bodies.size, 1, 'every failure looks the same');
  assert.equal(events(db).length, 0);
});

test('an issue without a link table never redirects', async () => {
  const { deps } = setup({ links: null });
  assert.equal((await handleTrackRequest(req(`/c/${await click(7, 1)}`), deps))!.status, 404);
});

test('other hosts and paths are left to the other routes', async () => {
  const { deps } = setup();
  assert.equal(await handleTrackRequest(req(`/c/${await click(7, 1)}`, { host: 'mailroom.example.com' }), deps), null);
  assert.equal(await handleTrackRequest(req('/u/abc'), deps), null);
  assert.equal(await handleTrackRequest(req(`/c/${await click(7, 1)}`), { ...deps, secrets: [] }), null, 'no secret = tracking off');
  const post = (await handleTrackRequest(req(`/c/${await click(7, 1)}`, { method: 'POST' }), deps))!;
  assert.equal(post.status, 405);
});

test('repeated clicks inside the dedupe window are one event; later clicks are new events', async () => {
  const { db, deps } = setup();
  const path = `/c/${await click(7, 2)}`;
  deps.setNow(T0 + 10 * 60_000);
  for (let i = 0; i < 3; i++) assert.equal((await handleTrackRequest(req(path), deps))!.status, 302);
  assert.equal(events(db).length, 1);
  deps.setNow(T0 + 12 * 60_000);
  await handleTrackRequest(req(path), deps);
  assert.equal(events(db).length, 2);
});

test('scanner burst: 3 different links within 60 s of sending are all marked, and last_click_at is not updated', async () => {
  const { db, deps } = setup();
  for (const [i, s] of [[1, 5], [2, 6], [3, 7]] as const) {
    deps.setNow(T0 + s * 1000);
    assert.equal((await handleTrackRequest(req(`/c/${await click(7, i)}`), deps))!.status, 302, 'scanner clicks still redirect');
  }
  const evs = events(db);
  assert.equal(evs.length, 3);
  for (const e of evs) {
    const d = JSON.parse(String(e.detail));
    assert.equal(d.suspect, 'scanner');
    assert.equal(d.scannerRule, 'burst');
  }
  // A human click later is not marked.
  deps.setNow(T0 + 30 * 60_000);
  await handleTrackRequest(req(`/c/${await click(7, 4)}`), deps);
  assert.equal(JSON.parse(String(events(db)[3].detail)).suspect, undefined);
});

test('two links soon after sending are not a burst', async () => {
  const { db, deps } = setup();
  deps.setNow(T0 + 5000);
  await handleTrackRequest(req(`/c/${await click(7, 1)}`), deps);
  deps.setNow(T0 + 6000);
  await handleTrackRequest(req(`/c/${await click(7, 2)}`), deps);
  for (const e of events(db)) assert.equal(JSON.parse(String(e.detail)).suspect, undefined);
});

test('HEAD requests and configured scanner networks are marked as scanner', async () => {
  const { db, deps } = setup();
  deps.settings = resolveTrackSettings({ scannerAsns: [64500] });
  await handleTrackRequest(req(`/c/${await click(7, 1)}`, { method: 'HEAD' }), deps);
  await handleTrackRequest(req(`/c/${await click(7, 2)}`, { asn: 64500 }), deps);
  const [a, b] = events(db).map((e) => JSON.parse(String(e.detail)));
  assert.deepEqual([a.suspect, a.scannerRule], ['scanner', 'head']);
  assert.deepEqual([b.suspect, b.scannerRule, b.asn], ['scanner', 'asn', 64500]);
});

test('event write failure still redirects (and still serves the pixel)', async () => {
  const { db, deps } = setup();
  const broken: Db = {
    prepare(sql: string) {
      if (/^\s*(INSERT|UPDATE)/i.test(sql)) throw new Error('database is down');
      return db.prepare(sql);
    },
  };
  const res = (await handleTrackRequest(req(`/c/${await click(7, 1)}`), { ...deps, db: broken }))!;
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://example.com/a?utm_source=newsletter');
  const pix = (await handleTrackRequest(req(`/o/${await open(7)}.gif`), { ...deps, db: broken }))!;
  assert.equal(pix.status, 200);
  // With waitUntil the redirect does not wait for the write at all.
  let pending: Promise<unknown> | null = null;
  const fast = (await handleTrackRequest(req(`/c/${await click(7, 2)}`), { ...deps, db: broken, waitUntil: (p) => { pending = p; } }))!;
  assert.equal(fast.status, 302);
  await pending;
});

test('link table read failure returns 503, never a redirect elsewhere', async () => {
  const { deps } = setup();
  const broken: Db = { prepare() { throw new Error('down'); } };
  const res = (await handleTrackRequest(req(`/c/${await click(7, 1)}`), { ...deps, db: broken }))!;
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('location'), null);
});

test('open pixel: always a gif; valid opens recorded, prefetch flagged explicitly, deduped per window', async () => {
  const { db, deps } = setup();
  const good = `/o/${await open(7)}.gif`;
  const r1 = (await handleTrackRequest(req(good, { ua: 'Mozilla/5.0', asn: 714 }), deps))!;
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('content-type'), 'image/gif');
  await handleTrackRequest(req(good, { ua: 'Mozilla/5.0', asn: 714 }), deps);
  await handleTrackRequest(req(good, { ua: 'Mozilla/5.0 (Windows NT 10.0)', asn: 64501 }), deps);
  const evs = events(db).map((e) => ({ type: e.type, d: JSON.parse(String(e.detail)) }));
  assert.equal(evs.length, 2, 'prefetch and human opens are counted separately, each once per window');
  assert.equal(evs[0].d.prefetch, true);
  assert.equal(evs[0].d.asn, 714);
  assert.equal(evs[1].d.prefetch, undefined);
  const m = db.raw.prepare('SELECT last_open_at FROM list_members WHERE contact_id = 7').get() as { last_open_at: string | null };
  assert.ok(m.last_open_at, 'human open updates last_open_at');
  // Bad tokens still get the gif, and record nothing.
  for (const p of ['/o/nope.gif', `/o/${await open(7, 'attacker-secret-0123456789')}.gif`, `/o/${await click(7, 1)}.gif`, `/o/${await open(7)}`]) {
    const r = (await handleTrackRequest(req(p), deps))!;
    assert.equal(r.status, 200, p);
  }
  assert.equal(events(db).length, 2);
});

test('prefetch by user agent is configurable', async () => {
  const { db, deps } = setup();
  deps.settings = resolveTrackSettings({ prefetchAsns: [], prefetchUserAgents: ['ExampleProxy'] });
  await handleTrackRequest(req(`/o/${await open(7)}.gif`, { ua: 'Mozilla/5.0 exampleproxy/1.0', asn: 714 }), deps);
  assert.equal(JSON.parse(String(events(db)[0].detail)).prefetch, true);
});

test('test mail (contact 0) redirects but records nothing', async () => {
  const { db, deps } = setup();
  assert.equal((await handleTrackRequest(req(`/c/${await click(0, 1)}`), deps))!.status, 302);
  await handleTrackRequest(req(`/o/${await open(0)}.gif`), deps);
  assert.equal(events(db).length, 0);
});

test('checkLinks and trackHost', () => {
  assert.deepEqual(checkLinks([{ index: 1, url: 'https://example.com/' }]), [{ index: 1, url: 'https://example.com/' }]);
  for (const bad of [[{ index: 2, url: 'https://example.com/' }], [{ index: 1, url: 'javascript:alert(1)' }], [{ index: 1, url: 'https://example.com/\r\nx' }], [{ index: 1, url: 'mailto:a@example.com' }], 'x', [null]]) assert.equal(checkLinks(bad), null, JSON.stringify(bad));
  assert.equal(trackHost('https://T.example.com'), 't.example.com');
  for (const bad of ['http://t.example.com', 'https://t.example.com/x', 'nope', undefined]) assert.equal(trackHost(bad), null);
});

test('saveDraft requires a link table covering every {{c:N}}', async () => {
  const db = memoryDb();
  db.raw.exec(`INSERT INTO lists (id, name, created_at) VALUES ('weekly', 'Weekly', '2027-01-01T00:00:00Z')`);
  const base = { id: 'weekly-5', list: 'weekly', subject: 's', from: 'n@mail.example.com', text: 'go https://t.example.com/c/{{c:1}}', webUrl: 'https://example.com/p/5', audience: { waves: [['*']] } };
  const html = '<a href="https://t.example.com/c/{{c:1}}">a</a><a href="https://t.example.com/c/{{c:2}}">b</a>';
  assert.deepEqual(await saveDraft(db, { ...base, html }, { marketingDomain: 'mail.example.com' }), { ok: false, reason: 'links_missing' });
  assert.deepEqual(await saveDraft(db, { ...base, html, links: [{ index: 1, url: 'https://example.com/a' }] }, { marketingDomain: 'mail.example.com' }), { ok: false, reason: 'links_missing' });
  assert.deepEqual(await saveDraft(db, { ...base, html, links: [{ index: 1, url: 'javascript:x' }, { index: 2, url: 'https://example.com/b' }] }, { marketingDomain: 'mail.example.com' }), { ok: false, reason: 'bad_links' });
  const ok = await saveDraft(db, { ...base, html, links: [{ index: 1, url: 'https://example.com/a' }, { index: 2, url: 'https://example.com/b' }] }, { marketingDomain: 'mail.example.com' });
  assert.equal(ok.ok, true);
  const row = db.raw.prepare("SELECT links FROM campaigns WHERE id = 'weekly-5'").get() as { links: string };
  assert.deepEqual(JSON.parse(row.links), [{ index: 1, url: 'https://example.com/a' }, { index: 2, url: 'https://example.com/b' }]);
  // Changing only a destination changes the content (approval must be redone).
  const changed = await saveDraft(db, { ...base, html, links: [{ index: 1, url: 'https://example.com/a' }, { index: 2, url: 'https://example.com/other' }] }, { marketingDomain: 'mail.example.com' });
  assert.deepEqual(changed, { ok: true, status: 'draft', changed: true });
});

test('broadcast render signs per recipient tokens that the endpoint accepts', async () => {
  const { db, deps } = setup();
  const track = trackFromEnv({ DB: {} as D1Database, TRACK_TOKEN_SECRET: SECRET });
  assert.ok(track);
  const render = personalizeRender(() => ({ unsubscribe_url: 'https://u.example.com/u/x' }), track);
  const c = db.raw.prepare("SELECT * FROM campaigns WHERE id = 'weekly-1'").get() as never;
  const campaign = { ...(c as object), html: '<a href="https://t.example.com/c/{{c:3}}">x</a><img src="https://t.example.com/o/{{o}}.gif"> {{unsubscribe_url}}', text: 'https://t.example.com/c/{{c:3}} {{unsubscribe_url}}', web_url: 'https://example.com/p/1', headers: null } as never;
  const out = await render(campaign, { campaign_id: 'weekly-1', contact_id: 7, email: 'reader@example.com', name: null } as never);
  const m = /https:\/\/t\.example\.com(\/c\/[^"]+)"/.exec(out.html)!;
  const res = (await handleTrackRequest(req(m[1]), deps))!;
  assert.equal(res.headers.get('location'), 'https://example.com/c');
  const o = /https:\/\/t\.example\.com(\/o\/[^"]+)"/.exec(out.html)!;
  await handleTrackRequest(req(o[1]), deps);
  assert.deepEqual(events(db).map((e) => e.type), ['click', 'open']);
  // A placeholder past the link table refuses to render (the issue pauses instead of sending a broken link).
  const bad = { ...(campaign as object), html: '<a href="https://t.example.com/c/{{c:9}}">x</a> {{unsubscribe_url}}' } as never;
  await assert.rejects(render(bad, { campaign_id: 'weekly-1', contact_id: 7, email: 'reader@example.com', name: null } as never));
  // No secret: content with tracking placeholders cannot be rendered.
  const noTrack = personalizeRender(() => ({ unsubscribe_url: 'https://u.example.com/u/x' }), trackFromEnv({ DB: {} as D1Database }));
  await assert.rejects(noTrack(campaign, { campaign_id: 'weekly-1', contact_id: 7, email: 'reader@example.com', name: null } as never));
});

test('trackSigner only signs what the content uses', async () => {
  const sign = await trackSigner(SECRET, 'weekly-1', 7, ['{{c:1}} {{c:2}}'], 2);
  assert.ok(await verifyTrack([SECRET], sign('c', 2), 'c'));
  assert.throws(() => sign('c', 3));
  await assert.rejects(trackSigner(SECRET, 'weekly-1', 7, ['{{c:3}}'], 2));
});
