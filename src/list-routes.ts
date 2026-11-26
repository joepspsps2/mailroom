// 名單管理入口（帶管理口令）的路由：PUT /v1/lists/{id}、POST /v1/lists/{id}/import、POST /v1/lists/{id}/segments、
// PUT／GET /v1/lists/{id}/welcome（歡迎信，見 src/welcome.ts）。
// 從 index.ts 抽出來，測試不必載入 cloudflare:workers。路徑不是這三個＝回 null，交給後面的路由。

import { bodySizeProblem, takeRate, type Db } from './core.ts';
import { bearer, json, notFound, sameToken } from './http.ts';
import { importMembers, setSegments, upsertList, type ImportOptions, type ImportRow, type ListDb, type SegmentInput } from './lists.ts';
import { getWelcome, saveWelcome, type WelcomeInput } from './welcome.ts';

/** 管理口令入口合計上限：口令外洩時，別人拿它也做不了太多事。 */
export const ADMIN_LIMITS = { perMinute: 20, perDay: 200 };
/** 名單管理入口的請求內文上限：匯入 2,000 筆、分群 5,000 筆都放得下。 */
export const MAX_LIST_BYTES = 1_500_000;

const LIST_PATH = /^\/v1\/lists\/([a-z0-9][a-z0-9-]{0,39})(\/import|\/segments|\/welcome)?$/;

export async function routeLists(request: Request, db: ListDb & Db, adminToken: string | undefined, marketingDomain?: string): Promise<Response | null> {
  const url = new URL(request.url);
  const m = LIST_PATH.exec(url.pathname);
  if (!m) return null;
  const wanted = m[2] === '/welcome' ? ['PUT', 'GET'] : m[2] ? ['POST'] : ['PUT'];
  if (!wanted.includes(request.method)) return notFound();
  if (!sameToken(bearer(request), adminToken ?? '')) return notFound();
  const adminOver = await takeRate(db, '_admin', ADMIN_LIMITS);
  if (adminOver) return new Response('rate limited', { status: 429, headers: { 'retry-after': adminOver === 'day' ? '3600' : '60' } });
  if (m[2] === '/welcome' && request.method === 'GET') {
    const w = await getWelcome(db, m[1]);
    return w
      ? json({ ok: true, list: w.list_id, subject: w.subject, from: w.from_addr, replyTo: w.reply_to, webUrl: w.web_url, enabled: Boolean(w.enabled), contentHash: w.content_hash, updatedAt: w.updated_at, html: w.html, text: w.text })
      : json({ ok: false, reason: 'not_found' }, 404);
  }
  const size = bodySizeProblem(request.headers.get('content-length'), MAX_LIST_BYTES);
  if (size) return json({ ok: false, reason: size === 'missing' ? 'length_required' : 'too_large' }, size === 'missing' ? 411 : 413);
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ ok: false, reason: 'bad_json' }, 400);
  const id = m[1];
  if (m[2] === '/welcome') {
    if (!marketingDomain) return json({ ok: false, reason: 'marketing_domain_not_set' }, 400);
    const r = await saveWelcome(db, id, body as unknown as WelcomeInput, { marketingDomain });
    return json(r, r.ok ? 200 : 400);
  }
  if (!m[2]) {
    const r = await upsertList(db, { id, name: body.name as string, fromAddr: body.fromAddr as string | undefined, replyTo: body.replyTo as string | undefined, welcomeTemplate: body.welcomeTemplate as string | undefined });
    return json(r, r.ok ? 200 : 400);
  }
  if (m[2] === '/segments') {
    const r = await setSegments(db, id, body.items as SegmentInput[]);
    return json(r, r.ok ? 200 : r.reason === 'too_many' ? 413 : 400);
  }
  const expected = body.expected;
  if (expected !== undefined && (expected === null || typeof expected !== 'object' || Array.isArray(expected))) return json({ ok: false, reason: 'bad_body' }, 400);
  const opts: ImportOptions = { importedFrom: body.importedFrom as string, dryRun: body.dryRun === true, expected: expected as ImportOptions['expected'] };
  const r = await importMembers(db, id, body.rows as ImportRow[], opts);
  return json(r, r.ok ? 200 : r.reason === 'too_many' ? 413 : 400);
}
