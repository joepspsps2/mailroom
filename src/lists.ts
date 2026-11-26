// 電子報名單：加入、退出、查狀態、分頁列出、批次匯入、分群欄位寫入。
// 單份退訂記在 list_members；全域拒收（suppressions）只放硬退信、檢舉、「全部都不要」。
// 不 import cloudflare:*，測試用 Node 內建 SQLite 跑同一份 SQL。

import { type Db, type Stmt } from './core.ts';

/** D1 的 batch（一次交多條、整批成功或整批失敗）是選配：沒有就逐條跑。D1Database 本身就符合。 */
export type ListDb = Db & { batch?(statements: Stmt[]): Promise<Array<{ meta: { changes?: number } }>> };

export const UNSUB_SOURCES = ['link', 'one_click', 'mailto', 'api', 'import', 'import-removed', 'complaint'] as const;
export type UnsubSource = (typeof UNSUB_SOURCES)[number];
/** 還沒有分群資料的新加入者。 */
export const NEW_SEGMENT = '新進觀察群';

const EMAIL = /^[^\s,;<>"'@]+@[^\s,;<>"'@]+\.[^\s,;<>"'@]+$/;
const LIST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TEXT = 200;
/** D1 一條 SQL 最多 100 個綁定值；批次內每次查詢的信箱數留餘裕。 */
const CHUNK = 40;
const BATCH = 100;
export const MAX_IMPORT_ROWS = 2000;
export const MAX_SEGMENT_ROWS = 5000;
export const MEMBERS_PAGE = 1000;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && !/[\u0000-\u001f\u007f]/.test(e) && EMAIL.test(e) ? e : null;
}

const text = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const iso = (now?: () => Date) => (now ?? (() => new Date()))().toISOString();

async function runAll(db: ListDb, stmts: Stmt[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < stmts.length; i += BATCH) {
    const part = stmts.slice(i, i + BATCH);
    if (db.batch) {
      for (const r of await db.batch(part)) out.push(r.meta.changes ?? 0);
    } else {
      // 沒有 batch：照順序逐條跑（後面的條件依賴前面的列）。
      for (const s of part) out.push((await s.run()).meta.changes ?? 0);
    }
  }
  return out;
}

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

// ---------- 名單本身 ----------

export interface ListInput { id: string; name: string; fromAddr?: string; replyTo?: string; welcomeTemplate?: string }

/** 建立或更新一份名單（同 id 再呼叫＝改名稱與寄件資訊）。 */
export async function upsertList(db: ListDb, input: ListInput, now?: () => Date): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!input || typeof input.id !== 'string' || !LIST_ID.test(input.id)) return { ok: false, reason: 'bad_list' };
  const name = text(input.name);
  if (!name) return { ok: false, reason: 'bad_name' };
  await db
    .prepare(
      `INSERT INTO lists (id, name, from_addr, reply_to, welcome_template, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, from_addr = excluded.from_addr, reply_to = excluded.reply_to, welcome_template = excluded.welcome_template`,
    )
    .bind(input.id, name, text(input.fromAddr, 320), text(input.replyTo, 320), text(input.welcomeTemplate), iso(now))
    .run();
  return { ok: true };
}

async function listExists(db: ListDb, id: unknown): Promise<boolean> {
  if (typeof id !== 'string' || !LIST_ID.test(id)) return false;
  return !!(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(id).first());
}

/** 這個信箱有沒有任何「電子報會擋」的全域拒收原因。 */
async function globalBlock(db: ListDb, email: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 AS x FROM suppressions WHERE email = ? AND reason IN ('hard_bounce', 'complaint', 'unsubscribe') LIMIT 1").bind(email).first());
}

async function contactId(db: ListDb, email: string, name: string | null, now: string): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO contacts (email, name, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (email) DO UPDATE SET name = COALESCE(contacts.name, excluded.name), updated_at = excluded.updated_at
       RETURNING id`,
    )
    .bind(email, name, now, now)
    .first<{ id: number }>();
  return Number(row!.id);
}

// ---------- 加入、退出、查狀態 ----------

export interface SubscribeInput { list: string; email: string; source?: string; consentVersion?: string; name?: string }
/**
 * subscribed 會多帶 firstTime：true＝這個人以前從來不是這份名單的成員（第一次加入）；false＝退訂後再訂回。
 * 歡迎信只寄給 firstTime 的人。
 */
export type SubscribeResult = { status: 'subscribed'; firstTime: boolean } | { status: 'already' | 'blocked' } | { status: 'rejected'; reason: 'bad_list' | 'unknown_list' | 'bad_email' };

/**
 * 加入。回 subscribed（新加入或退訂後再訂回）、already（本來就在）、blocked（在全域拒收名單，不加）。
 * 只有「讀者本人的加入動作」能把 unsubscribed 改回 subscribed；批次匯入與同步做不到（見 importMembers）。
 */
export async function listSubscribe(db: ListDb, input: SubscribeInput, now?: () => Date): Promise<SubscribeResult> {
  const r = await subscribeMember(db, input, now);
  return r.status === 'subscribed' ? { status: 'subscribed', firstTime: r.firstTime } : r;
}

/** 同 listSubscribe，另外回聯絡人編號（給引擎內部排歡迎信用，不對外）。 */
export async function subscribeMember(db: ListDb, input: SubscribeInput, now?: () => Date): Promise<SubscribeResult | { status: 'subscribed'; firstTime: boolean; contactId: number }> {
  const email = normalizeEmail(input?.email);
  if (!email) return { status: 'rejected', reason: 'bad_email' };
  if (typeof input.list !== 'string' || !LIST_ID.test(input.list)) return { status: 'rejected', reason: 'bad_list' };
  if (!(await listExists(db, input.list))) return { status: 'rejected', reason: 'unknown_list' };
  if (await globalBlock(db, email)) return { status: 'blocked' };
  const t = iso(now);
  const existing = await db
    .prepare('SELECT m.status AS status FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?')
    .bind(input.list, email)
    .first<{ status: string }>();
  if (existing?.status === 'subscribed') return { status: 'already' };
  const firstTime = !existing;
  const id = await contactId(db, email, text(input.name), t);
  // 新加入與退訂後再訂回走同一條：退訂欄位清空、來源記新入口。
  await db
    .prepare(
      `INSERT INTO list_members (list_id, contact_id, status, subscribed_at, source, consent_version, segment, updated_at)
       VALUES (?, ?, 'subscribed', ?, ?, ?, ?, ?)
       ON CONFLICT (list_id, contact_id) DO UPDATE SET
         status = 'subscribed', subscribed_at = excluded.subscribed_at, unsubscribed_at = NULL, unsub_source = NULL,
         source = excluded.source, consent_version = excluded.consent_version, updated_at = excluded.updated_at`,
    )
    .bind(input.list, id, t, text(input.source), text(input.consentVersion), NEW_SEGMENT, t)
    .run();
  return { status: 'subscribed', firstTime, contactId: id };
}

export interface UnsubscribeInput { list: string; email: string; source?: UnsubSource }
export type UnsubscribeResult = { status: 'unsubscribed' | 'not_member' } | { status: 'rejected'; reason: 'bad_list' | 'unknown_list' | 'bad_email' | 'bad_source' };

/** 退出這一份名單（不碰別份、不碰全域拒收）。已經退訂＝回 unsubscribed、不改原本的時間與來源（重複點擊安全）。 */
export async function listUnsubscribe(db: ListDb, input: UnsubscribeInput, now?: () => Date): Promise<UnsubscribeResult> {
  const email = normalizeEmail(input?.email);
  if (!email) return { status: 'rejected', reason: 'bad_email' };
  if (typeof input.list !== 'string' || !LIST_ID.test(input.list)) return { status: 'rejected', reason: 'bad_list' };
  const source = input.source ?? 'api';
  if (!UNSUB_SOURCES.includes(source)) return { status: 'rejected', reason: 'bad_source' };
  if (!(await listExists(db, input.list))) return { status: 'rejected', reason: 'unknown_list' };
  const t = iso(now);
  const row = await db
    .prepare(
      `UPDATE list_members SET
         status = 'unsubscribed',
         unsubscribed_at = CASE WHEN status = 'unsubscribed' THEN unsubscribed_at ELSE ? END,
         unsub_source = CASE WHEN status = 'unsubscribed' THEN unsub_source ELSE ? END,
         updated_at = CASE WHEN status = 'unsubscribed' THEN updated_at ELSE ? END
       WHERE list_id = ? AND contact_id = (SELECT id FROM contacts WHERE email = ?)
       RETURNING contact_id`,
    )
    .bind(t, source, t, input.list, email)
    .first();
  return { status: row ? 'unsubscribed' : 'not_member' };
}

export type ListStatus = 'subscribed' | 'unsubscribed' | 'not_found' | 'blocked';

/**
 * 查狀態。已退訂＝unsubscribed；訂閱中但在全域拒收＝blocked（不寄）；不是成員但在拒收名單＝blocked；其他 not_found。
 * 給會員中心對帳用：畫面上不要因為 blocked 就透露別人的狀態。
 */
export async function listStatus(db: ListDb, input: { list: string; email: string }): Promise<ListStatus | { status: 'rejected'; reason: 'bad_email' | 'bad_list' }> {
  const email = normalizeEmail(input?.email);
  if (!email) return { status: 'rejected', reason: 'bad_email' };
  if (typeof input.list !== 'string' || !LIST_ID.test(input.list)) return { status: 'rejected', reason: 'bad_list' };
  const m = await db
    .prepare('SELECT m.status AS status FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?')
    .bind(input.list, email)
    .first<{ status: 'subscribed' | 'unsubscribed' }>();
  if (m?.status === 'unsubscribed') return 'unsubscribed';
  if (await globalBlock(db, email)) return 'blocked';
  return m ? 'subscribed' : 'not_found';
}

export interface MemberRow { email: string; status: 'subscribed' | 'unsubscribed'; subscribedAt: string | null; unsubscribedAt: string | null; unsubSource: string | null; unsubReason: string | null; source: string | null; segment: string | null; segmentLabel: string | null;
  /** 這個信箱在全域拒收名單（硬退信、檢舉、「全部不要」）＝不會寄；與 listStatus 的 blocked 同口徑。 */
  suppressed: boolean }
export interface MembersPage { members: MemberRow[]; next: string | null }

/** 分頁列出（依 contact id 遞增，一頁最多 1,000）。cursor＝上一頁回的 next；next 為 null＝沒有下一頁。 */
export async function listMembers(db: ListDb, input: { list: string; status?: 'subscribed' | 'unsubscribed'; cursor?: string | null; limit?: number }): Promise<MembersPage | { status: 'rejected'; reason: 'bad_list' | 'bad_status' | 'bad_cursor' }> {
  if (typeof input?.list !== 'string' || !LIST_ID.test(input.list)) return { status: 'rejected', reason: 'bad_list' };
  if (input.status !== undefined && input.status !== 'subscribed' && input.status !== 'unsubscribed') return { status: 'rejected', reason: 'bad_status' };
  let after = 0;
  if (input.cursor !== undefined && input.cursor !== null && input.cursor !== '') {
    if (!/^\d{1,15}$/.test(String(input.cursor))) return { status: 'rejected', reason: 'bad_cursor' };
    after = Number(input.cursor);
  }
  const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || MEMBERS_PAGE, 1), MEMBERS_PAGE);
  const rows = await db
    .prepare(
      `SELECT m.contact_id AS id, c.email AS email, m.status AS status, m.subscribed_at AS subscribedAt, m.unsubscribed_at AS unsubscribedAt,
              m.unsub_source AS unsubSource, m.unsub_reason AS unsubReason, m.source AS source, m.segment AS segment, m.segment_label AS segmentLabel,
              EXISTS (SELECT 1 FROM suppressions s WHERE s.email = c.email AND s.reason IN ('hard_bounce', 'complaint', 'unsubscribe')) AS suppressed
         FROM list_members m JOIN contacts c ON c.id = m.contact_id
        WHERE m.list_id = ? AND m.contact_id > ? ${input.status ? 'AND m.status = ?' : ''}
        ORDER BY m.contact_id LIMIT ?`,
    )
    .bind(...[input.list, after, ...(input.status ? [input.status] : []), limit + 1])
    .all<Omit<MemberRow, 'suppressed'> & { id: number; suppressed: number }>();
  const more = rows.results.length > limit;
  const page = rows.results.slice(0, limit);
  const next = more ? String(page[page.length - 1].id) : null;
  return { members: page.map(({ id: _id, suppressed, ...m }) => ({ ...m, suppressed: !!suppressed })), next };
}

// ---------- 分群欄位寫入 ----------

export interface SegmentInput { email: string; segment: string; segmentLabel?: string }
export type SegmentResult = { ok: true; updated: number; notMember: number; invalid: number } | { ok: false; reason: 'bad_list' | 'unknown_list' | 'too_many' | 'bad_body' };

/**
 * 寫入分群欄位（每週從分析那頭抄一份）。只更新已經在名單裡的人，不建立新成員；同一份再送一次結果一樣（冪等）。
 * 一次最多 5,000 筆；無效的列（信箱或分群空白）略過並計數。
 */
export async function setSegments(db: ListDb, listId: string, items: SegmentInput[], now?: () => Date): Promise<SegmentResult> {
  if (typeof listId !== 'string' || !LIST_ID.test(listId)) return { ok: false, reason: 'bad_list' };
  if (!Array.isArray(items)) return { ok: false, reason: 'bad_body' };
  if (items.length > MAX_SEGMENT_ROWS) return { ok: false, reason: 'too_many' };
  if (!(await listExists(db, listId))) return { ok: false, reason: 'unknown_list' };
  const t = iso(now);
  const stmts: Stmt[] = [];
  let invalid = 0;
  for (const it of items) {
    const email = normalizeEmail(it?.email);
    const segment = text(it?.segment, 100);
    if (!email || !segment) { invalid++; continue; }
    stmts.push(
      db
        .prepare('UPDATE list_members SET segment = ?, segment_label = ?, segment_at = ? WHERE list_id = ? AND contact_id = (SELECT id FROM contacts WHERE email = ?)')
        .bind(segment, text(it.segmentLabel, 100), t, listId, email),
    );
  }
  const changes = await runAll(db, stmts);
  const updated = changes.filter((n) => n > 0).length;
  return { ok: true, updated, notMember: changes.length - updated, invalid };
}

// ---------- 批次匯入 ----------

export const IMPORT_STATUSES = ['subscribed', 'unsubscribed', 'bounced', 'removed', 'complained'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
/** 同一個信箱在同一批裡出現多次時，取限制最多的那一筆。 */
const RESTRICTIVENESS: Record<ImportStatus, number> = { subscribed: 1, unsubscribed: 2, removed: 3, bounced: 4, complained: 5 };

export interface ImportRow { email: string; status: ImportStatus; name?: string; subscribedAt?: string; unsubscribedAt?: string; source?: string; consentVersion?: string }
export interface ImportOptions {
  /** 來源系統代號，寫進 imported_from。 */
  importedFrom: string;
  /** 只驗證與試算、不寫入。 */
  dryRun?: boolean;
  /** 對帳用：預期去重後各狀態的筆數。對不上就整批不寫。 */
  expected?: Partial<Record<ImportStatus, number>>;
}
export type ImportOutcome = 'subscribed_new' | 'subscribed_unchanged' | 'kept_unsubscribed' | 'blocked' | 'unsubscribed' | 'unsubscribed_unchanged' | 'suppressed' | 'suppressed_unchanged';
export type ImportReport =
  | { ok: true; dryRun: boolean; total: number; duplicates: number; received: Record<ImportStatus, number>; outcomes: Record<ImportOutcome, number> }
  | { ok: false; reason: 'bad_list' | 'unknown_list' | 'bad_body' | 'too_many' | 'bad_source' | 'invalid_rows' | 'count_mismatch'; problems?: Array<{ index: number; reason: string }>; received?: Record<ImportStatus, number> };

const zero = <K extends string>(keys: readonly K[]) => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
const OUTCOMES: readonly ImportOutcome[] = ['subscribed_new', 'subscribed_unchanged', 'kept_unsubscribed', 'blocked', 'unsubscribed', 'unsubscribed_unchanged', 'suppressed', 'suppressed_unchanged'];

/**
 * 批次匯入（搬家用）。規則：
 * - subscribed：進名單；但信箱在全域拒收名單 → blocked 不進；已經是 unsubscribed → 維持不變（匯入不准把退訂改回訂閱）。
 * - unsubscribed／removed：記成這份名單的 unsubscribed（unsub_source＝import／import-removed）；已退訂的不動；不進全域拒收。
 * - bounced／complained：進全域拒收（hard_bounce／complaint，source＝import），不建立名單成員。
 * - 先整批驗證（信箱格式、狀態、expected 筆數），任何一筆不合格就整批不寫；通過才寫，寫入冪等，重跑不會重複、不會多出成員。
 */
export async function importMembers(db: ListDb, listId: string, rows: ImportRow[], opts: ImportOptions, now?: () => Date): Promise<ImportReport> {
  if (typeof listId !== 'string' || !LIST_ID.test(listId)) return { ok: false, reason: 'bad_list' };
  if (!Array.isArray(rows)) return { ok: false, reason: 'bad_body' };
  if (rows.length > MAX_IMPORT_ROWS) return { ok: false, reason: 'too_many' };
  const importedFrom = text(opts?.importedFrom, 40);
  if (!importedFrom) return { ok: false, reason: 'bad_source' };
  if (!(await listExists(db, listId))) return { ok: false, reason: 'unknown_list' };

  const problems: Array<{ index: number; reason: string }> = [];
  const byEmail = new Map<string, ImportRow & { email: string }>();
  let duplicates = 0;
  rows.forEach((r, index) => {
    const email = normalizeEmail(r?.email);
    if (!email) return void problems.push({ index, reason: 'bad_email' });
    if (!IMPORT_STATUSES.includes(r.status)) return void problems.push({ index, reason: 'bad_status' });
    const prev = byEmail.get(email);
    if (prev) {
      duplicates++;
      if (RESTRICTIVENESS[r.status] <= RESTRICTIVENESS[prev.status]) return;
    }
    byEmail.set(email, { ...r, email });
  });
  if (problems.length) return { ok: false, reason: 'invalid_rows', problems: problems.slice(0, 20) };

  const received = zero(IMPORT_STATUSES);
  for (const r of byEmail.values()) received[r.status]++;
  for (const [k, n] of Object.entries(opts.expected ?? {})) {
    if (IMPORT_STATUSES.includes(k as ImportStatus) && received[k as ImportStatus] !== n) return { ok: false, reason: 'count_mismatch', received };
  }

  const t = iso(now);
  const outcomes = zero(OUTCOMES);
  const all = [...byEmail.values()];
  for (let i = 0; i < all.length; i += CHUNK) {
    const chunk = all.slice(i, i + CHUNK);
    const emails = chunk.map((r) => r.email);
    const members = new Map(
      (
        await db
          .prepare(`SELECT c.email AS email, m.status AS status FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email IN (${marks(emails.length)})`)
          .bind(listId, ...emails)
          .all<{ email: string; status: string }>()
      ).results.map((x) => [x.email, x.status]),
    );
    const supp = new Map<string, Set<string>>();
    for (const x of (await db.prepare(`SELECT email, reason FROM suppressions WHERE email IN (${marks(emails.length)})`).bind(...emails).all<{ email: string; reason: string }>()).results) {
      (supp.get(x.email) ?? supp.set(x.email, new Set()).get(x.email)!).add(x.reason);
    }

    const stmts: Stmt[] = [];
    const contactStmt = (r: ImportRow & { email: string }) =>
      db
        .prepare(`INSERT INTO contacts (email, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (email) DO UPDATE SET name = COALESCE(contacts.name, excluded.name), updated_at = excluded.updated_at`)
        .bind(r.email, text(r.name), t, t);
    const idOf = '(SELECT id FROM contacts WHERE email = ?)';

    for (const r of chunk) {
      const existing = members.get(r.email);
      const reasons = supp.get(r.email);
      if (r.status === 'subscribed') {
        if (reasons && reasons.size) { outcomes.blocked++; continue; }
        if (existing === 'unsubscribed') { outcomes.kept_unsubscribed++; continue; }
        if (existing === 'subscribed') { outcomes.subscribed_unchanged++; continue; }
        outcomes.subscribed_new++;
        stmts.push(contactStmt(r));
        stmts.push(
          db
            .prepare(
              `INSERT INTO list_members (list_id, contact_id, status, subscribed_at, source, consent_version, segment, imported_from, updated_at)
               VALUES (?, ${idOf}, 'subscribed', ?, ?, ?, ?, ?, ?) ON CONFLICT (list_id, contact_id) DO NOTHING`,
            )
            .bind(listId, r.email, text(r.subscribedAt, 40) ?? t, text(r.source), text(r.consentVersion), NEW_SEGMENT, importedFrom, t),
        );
      } else if (r.status === 'unsubscribed' || r.status === 'removed') {
        if (existing === 'unsubscribed') { outcomes.unsubscribed_unchanged++; continue; }
        outcomes.unsubscribed++;
        stmts.push(contactStmt(r));
        stmts.push(
          db
            .prepare(
              `INSERT INTO list_members (list_id, contact_id, status, subscribed_at, unsubscribed_at, unsub_source, source, imported_from, updated_at)
               VALUES (?, ${idOf}, 'unsubscribed', ?, ?, ?, ?, ?, ?)
               ON CONFLICT (list_id, contact_id) DO UPDATE SET status = 'unsubscribed', unsubscribed_at = excluded.unsubscribed_at, unsub_source = excluded.unsub_source, updated_at = excluded.updated_at
               WHERE list_members.status != 'unsubscribed'`,
            )
            .bind(listId, r.email, text(r.subscribedAt, 40), text(r.unsubscribedAt, 40) ?? t, r.status === 'removed' ? 'import-removed' : 'import', text(r.source), importedFrom, t),
        );
      } else {
        const reason = r.status === 'bounced' ? 'hard_bounce' : 'complaint';
        if (reasons?.has(reason)) { outcomes.suppressed_unchanged++; continue; }
        outcomes.suppressed++;
        stmts.push(contactStmt(r));
        stmts.push(
          db
            .prepare('INSERT INTO suppressions (email, reason, source, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, reason) DO NOTHING')
            .bind(r.email, reason, 'import', importedFrom, t),
        );
      }
    }
    if (!opts.dryRun) await runAll(db, stmts);
  }
  return { ok: true, dryRun: !!opts.dryRun, total: all.length, duplicates, received, outcomes };
}
