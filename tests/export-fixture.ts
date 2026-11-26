// 匯出測試用：用假郵差跑兩期完整的信，再補上開信、點擊、掃描器點擊、退訂，產生一份「一期完整事件」。
// 同一份資料也可以寫成 NDJSON 檔給分析端的測試用（見檔尾 dumpFixture；信箱一律 @example.com 的假地址）。
import { makeWorld, type World } from './broadcast-helpers.ts';
import { ingestEvent } from '../src/broadcast/index.ts';
import { routeExport } from '../src/export.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { routeLists } from '../src/list-routes.ts';

export const TOKEN = 'export-token-for-tests';
/** 預設從過去的一個週日（台北 09:00）開始，讓分析端測試時「寄出已滿 7 天」成立。 */
export const FIXTURE_START = Date.parse('2026-10-04T01:00:00.000Z');
const SEGMENTS = ['活躍群', '觀察群', '沉睡群', '新進觀察群'];

/** 決定性的偽隨機（同一個 contact＋期別＋用途永遠同一個結果），讓測試與分析端的預期數字固定。 */
export function pick(contact: number, issue: number, salt: string): number {
  let h = 2166136261;
  for (const ch of `${contact}|${issue}|${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h % 10000) / 10000;
}

export interface Fixture {
  w: World;
  contacts: { id: number; email: string; segment: string }[];
  issues: string[];
  /** 每期各事件類型的預期數（扣掉掃描器點擊前後都記下，給分析端對數）。 */
  expected: Record<string, Record<string, number>>;
}

export async function buildFixture(opts: { members?: number; issues?: number; start?: number } = {}): Promise<Fixture> {
  const members = opts.members ?? 60;
  const issues = Array.from({ length: opts.issues ?? 2 }, (_, i) => `weekly-${163 + i}`);
  const w = await makeWorld({
    members,
    config: { paceMinutes: 1 },
    start: opts.start ?? FIXTURE_START,
    // 2 個假的退信地址、1 個檢舉地址（SES 模擬信箱的規則）
    emailOf: (i) => (i === 0 || i === 1 ? `bounce+${i}@example.com` : i === 2 ? 'complaint+2@example.com' : `reader${i}@example.com`),
    segmentOf: (i) => SEGMENTS[i % SEGMENTS.length],
  });
  const contacts = (await w.db.prepare('SELECT c.id AS id, c.email AS email, m.segment AS segment FROM contacts c JOIN list_members m ON m.contact_id = c.id ORDER BY c.id').all<{ id: number; email: string; segment: string }>()).results;
  const expected: Fixture['expected'] = {};
  let issueNo = 0;
  for (const id of issues) {
    issueNo++;
    await w.campaign(id);
    await w.run(200, { until: async () => (await w.status(id)).status === 'done' });
    const sent = await w.db.prepare("SELECT contact_id, at FROM events WHERE campaign_id = ? AND type = 'send' ORDER BY contact_id").bind(id).all<{ contact_id: number; at: string }>();
    const exp: Record<string, number> = { open: 0, click: 0, click_suspect: 0, open_apple: 0, unsubscribe: 0 };
    for (const s of sent.results) {
      const c = s.contact_id;
      const sentAt = Date.parse(s.at);
      const ev = async (type: 'open' | 'click' | 'unsubscribe', n: number, offsetMs: number, detail: Record<string, unknown>) => {
        await ingestEvent(w.db, { provider: 'self', providerEventId: `self:${id}:${c}:${type}:${n}`, type, at: new Date(sentAt + offsetMs).toISOString(), campaign: id, contact: String(c), detail }, { now: w.now });
      };
      // 開信：約 45%；其中一部分是 Apple 預載（寄出後幾秒就開、帶 ua 標記）；有人開兩次（同一人多筆事件，算一個開信者）
      if (pick(c, issueNo, 'open') < 0.45) {
        const apple = pick(c, issueNo, 'apple') < 0.25;
        await ev('open', 1, apple ? 4_000 : 3_600_000 + Math.floor(pick(c, issueNo, 'when') * 7_200_000), apple ? { ua: 'AppleMail MPP prefetch' } : { ua: 'Mozilla/5.0' });
        exp.open++;
        if (apple) exp.open_apple++;
        if (pick(c, issueNo, 'open2') < 0.3) await ev('open', 2, 86_400_000, { ua: 'Mozilla/5.0' });
      }
      // 點擊：開信者裡約 30% 點了某個連結；其中 2 人是掃描器（寄出後 20 秒內點 3 個不同連結，標 suspect）
      if (pick(c, issueNo, 'click') < 0.3 && pick(c, issueNo, 'open') < 0.45) {
        await ev('click', 1, 4_000_000, { url: 'https://www.example.com/a', linkIndex: 1 });
        exp.click++;
      }
      if (c % 29 === 0) {
        for (let k = 1; k <= 3; k++) await ev('click', 10 + k, 5_000 * k, { url: `https://www.example.com/l${k}`, linkIndex: k, suspect: 'scanner' });
        exp.click_suspect += 1;
      }
      if (c % 7 === 0 && issueNo === issues.length) {
        await ev('unsubscribe', 1, 90_000_000, { via: 'link' });
        exp.unsubscribe++;
      }
    }
    expected[id] = exp;
    w.clock.t += 7 * 86_400_000; // 下一期晚一週
  }
  await w.flushEvents();
  return { w, contacts, issues, expected };
}

export function exportCall(w: World, method: string, path: string, opts: { token?: string | null; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  return routeExport(new Request(`https://mailroom.example.com${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }), w.db, TOKEN, w.now);
}

/** 把整個匯出（四種）拉乾淨，寫成 NDJSON 到 dir：events.ndjson、campaigns.ndjson、recipients-{期}.ndjson、members-weekly.ndjson。 */
export async function dumpFixture(dir: string, opts: { members?: number; issues?: number; start?: number } = {}): Promise<Fixture> {
  const f = await buildFixture(opts);
  mkdirSync(dir, { recursive: true });
  const pull = async (path: string, file: string) => {
    let cursor = '';
    const lines: string[] = [];
    for (;;) {
      const r = (await exportCall(f.w, 'GET', `${path}${path.includes('?') ? '&' : '?'}limit=500&cursor=${cursor}`))!;
      const text = await r.text();
      if (text) lines.push(text.trimEnd());
      cursor = r.headers.get('x-export-next-cursor') ?? '';
      if (r.headers.get('x-export-has-more') !== '1') break;
    }
    writeFileSync(`${dir}/${file}`, lines.join('\n') + '\n');
  };
  await pull('/v1/export/events', 'events.ndjson');
  await pull('/v1/export/campaigns', 'campaigns.ndjson');
  for (const id of f.issues) await pull(`/v1/export/recipients?campaign=${id}`, `recipients-${id}.ndjson`);
  await pull('/v1/export/members?list=weekly', 'members-weekly.ndjson');
  writeFileSync(`${dir}/expected.json`, JSON.stringify({ expected: f.expected, start: new Date(opts.start ?? FIXTURE_START).toISOString() }, null, 1));
  return f;
}

/** 在本機開一個小伺服器（匯出＋名單分群兩組路由），讓分析端用真的 HTTP 測。印出 `listening <port>` 後等著。 */
export async function serveFixture(port: number, opts: { members?: number; issues?: number; start?: number } = {}): Promise<{ close: () => void; fixture: Fixture }> {
  const f = await buildFixture(opts);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    if (body.length) headers.set('content-length', String(body.length));
    const request = new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: body.length ? body : undefined });
    const response = (await routeExport(request.clone(), f.w.db, TOKEN, f.w.now)) ?? (await routeLists(request.clone(), f.w.db as never, TOKEN)) ?? new Response('Not found', { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return { close: () => server.close(), fixture: f };
}

if (process.argv[1]?.endsWith('export-fixture.ts') && process.argv[2] === '--serve') {
  const port = Number(process.argv[3] ?? 8787);
  await serveFixture(port);
  console.log(`listening ${port} token ${TOKEN}`);
} else if (process.argv[1]?.endsWith('export-fixture.ts') && process.argv[2]) {
  const f = await dumpFixture(process.argv[2]);
  console.log(`寫好了：${process.argv[2]}（${f.contacts.length} 位假讀者、${f.issues.length} 期）`);
}
