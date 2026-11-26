// 郵務室的帳本邏輯：拒收名單 → 去重 → 交郵差 → 記帳。
// 不 import cloudflare:*，測試用 Node 內建 SQLite 跑同一份 SQL（tests/helpers.ts）。

import { deliver, idempotencyKeyFor, MAIL_ROUTES, type MailRoute, type TransportKeys } from './transport.ts';

/** D1 用得到的那一小塊介面（D1Database 本身就符合）。 */
export interface Stmt {
  bind(...values: unknown[]): Stmt;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface Db {
  prepare(sql: string): Stmt;
}

export type Stream = 'transactional' | 'marketing';
/**
 * 掛號櫃台裡的兩層：notify＝第一層「一定要到」（登入、邀請、付款…）；
 * remind＝第二層「服務提醒」（待簽核、到期提醒、彙整…）。各用自己的寄件網域與郵差順序。
 */
export type Tier = 'notify' | 'remind';
export const TIERS: readonly Tier[] = ['notify', 'remind'];
/** 郵差順序表：鍵＝`站:層`、`*:層`；查不到用 DEFAULT_ROUTES。 */
export type RouteTable = Record<string, readonly MailRoute[]>;
export const DEFAULT_ROUTES: readonly MailRoute[] = ['resend', 'smtp2go'];
export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe';
export const SUPPRESSION_REASONS: readonly SuppressionReason[] = ['hard_bounce', 'complaint', 'unsubscribe'];

export interface SendRequest {
  site: string;
  /** 去重鍵：同一站同一把只寄一次（失敗的可以拿同一把重試）。 */
  key: string;
  /** 現在只開掛號櫃台，省略＝transactional。 */
  stream?: Stream;
  /** 第幾層；省略＝notify（第一層）。寄件地址必須是這一層的網域。 */
  tier?: Tier;
  kind?: string;
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

/**
 * sent＝這次寄出　duplicate＝這把鑰匙早就寄過了（不重寄）　in_flight＝同一把鑰匙正在寄，稍後再問
 * suppressed＝收件人在拒收名單　failed＝兩個郵差都失敗　rejected＝請求本身不合格（不要重試）
 */
export type SendStatus = 'sent' | 'duplicate' | 'in_flight' | 'suppressed' | 'failed' | 'rejected';

export interface SendResult {
  status: SendStatus;
  /** true＝站上應記「待寄」，稍後拿同一把鑰匙再送。 */
  retryable: boolean;
  route?: MailRoute;
  id?: number;
  reason?: string;
}

export interface MessageRow {
  id: number; stream: Stream; tier: Tier | null; site: string; dedupe_key: string; kind: string | null; to_email: string; from_addr: string;
  subject: string; status: string; route: string | null; provider_id: string | null; error: string | null; last_error: string | null; attempts: number;
  last_event: string | null; created_at: string; updated_at: string; sent_at: string | null;
}

export interface CoreDeps {
  db: Db;
  /** 第一層（notify）的郵差鑰匙；其他層沒給 tierKeys 就沿用這組。 */
  keys: TransportKeys;
  tierKeys?: Partial<Record<Tier, TransportKeys>>;
  /** 第一層的寄件網域（例 notify.example.com）。 */
  fromDomain: string;
  /** 其他層的寄件網域（例 { remind: 'remind.example.com' }）；沒設的層一律拒收。 */
  tierDomains?: Partial<Record<Tier, string>>;
  routes?: RouteTable;
  fetcher?: typeof fetch;
  now?: () => Date;
}

const EMAIL = /^[^\s,;<>"'@]+@[^\s,;<>"'@]+\.[^\s,;<>"'@]+$/;
const SITE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** 「正在寄」超過這麼久沒結果（Worker 中途被砍）就當失敗，可以重寄。 */
const STALE_SENDING_MS = 2 * 60_000;
const LIMITS = { key: 300, subject: 300, html: 400_000, text: 200_000, to: 254, kind: 64 };

/**
 * 寄件人只收兩種寫法：`a@b` 或 `顯示名稱 <a@b>`（名稱可加雙引號）。名稱不准有控制字元、<>"@,;\\；
 * 通過後由郵務室重組成 `名稱 <a@b>` 交郵差，原字串不往外送（防標頭注入、防騙過寄件網域檢查）。
 */
export function parseAddress(raw: string): { name: string | null; addr: string } | null {
  if (typeof raw !== 'string' || raw.length > 320 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const s = raw.trim();
  const m = /^(?:"([^"]*)"|([^<>"]*?))\s*<([^<>\s]+)>$/.exec(s);
  const name = m ? (m[1] ?? m[2] ?? '').trim() : null;
  const addr = (m ? m[3] : s).toLowerCase();
  if (!EMAIL.test(addr)) return null;
  if (name !== null && /[<>"@,;\\]/.test(name)) return null;
  // 顯示名稱不准有文字方向控制字元（可把名稱在收件匣裡倒著顯示，用來冒充別的寄件人）。
  if (name !== null && /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(name)) return null;
  return { name: name || null, addr };
}

const formatAddress = (a: { name: string | null; addr: string }) => (a.name ? `${a.name} <${a.addr}>` : a.addr);

/** 這一層的寄件網域；沒設＝這層沒開。 */
export function domainFor(deps: Pick<CoreDeps, 'fromDomain' | 'tierDomains'>, tier: Tier): string | null {
  return tier === 'notify' ? deps.fromDomain : deps.tierDomains?.[tier] ?? null;
}

/** 郵差順序：先找 `站:層`，再找 `*:層`，都沒有用預設（Resend → SMTP2GO）。表裡寫錯的郵差名字略過。 */
export function routeFor(table: RouteTable | undefined, site: string, tier: Tier): readonly MailRoute[] {
  const raw = table?.[`${site}:${tier}`] ?? table?.[`*:${tier}`];
  const clean = Array.isArray(raw) ? raw.filter((r): r is MailRoute => MAIL_ROUTES.includes(r as MailRoute)) : [];
  return clean.length > 0 ? clean : DEFAULT_ROUTES;
}

function validate(req: SendRequest, fromDomain: string | null): string | null {
  if (!req || typeof req !== 'object') return 'bad_request';
  if (!SITE.test(String(req.site ?? ''))) return 'bad_site';
  if (typeof req.key !== 'string' || !req.key || req.key.length > LIMITS.key || /[\u0000-\u001f\u007f]/.test(req.key)) return 'bad_key';
  if ((req.stream ?? 'transactional') !== 'transactional') return 'stream_closed'; // 印刷品櫃台還沒開
  if (!fromDomain) return 'bad_tier';
  if (typeof req.to !== 'string' || req.to.length > LIMITS.to || /[\u0000-\u001f\u007f]/.test(req.to) || !EMAIL.test(req.to)) return 'bad_to';
  if (req.kind !== undefined && req.kind !== null && (typeof req.kind !== 'string' || req.kind.length > LIMITS.kind || /[\u0000-\u001f\u007f]/.test(req.kind))) return 'bad_kind';
  const from = parseAddress(String(req.from ?? ''));
  if (!from || !from.addr.endsWith(`@${fromDomain}`)) return 'bad_from';
  if (typeof req.subject !== 'string' || !req.subject || req.subject.length > LIMITS.subject || /[\u0000-\u001f\u007f]/.test(req.subject)) return 'bad_subject';
  if (typeof req.html !== 'string' || typeof req.text !== 'string' || req.html.length > LIMITS.html || req.text.length > LIMITS.text) return 'bad_body';
  if (req.replyTo !== undefined && !parseAddress(req.replyTo)) return 'bad_reply_to';
  return null;
}

/** 這個信箱在這個櫃台會不會被擋；擋的話回原因。 */
export async function suppressedReason(db: Db, email: string, stream: Stream): Promise<SuppressionReason | null> {
  const reasons: SuppressionReason[] = stream === 'marketing' ? ['hard_bounce', 'complaint', 'unsubscribe'] : ['hard_bounce', 'complaint'];
  const row = await db
    .prepare(`SELECT reason FROM suppressions WHERE email = ? AND reason IN (${reasons.map(() => '?').join(',')}) LIMIT 1`)
    .bind(email.toLowerCase(), ...reasons)
    .first<{ reason: SuppressionReason }>();
  return row?.reason ?? null;
}

export async function addSuppression(db: Db, email: string, reason: SuppressionReason, source: string, detail: string | null, now = new Date()): Promise<boolean> {
  const r = await db
    .prepare('INSERT INTO suppressions (email, reason, source, detail, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (email, reason) DO NOTHING')
    .bind(email.trim().toLowerCase(), reason, source, detail ? detail.slice(0, 300) : null, now.toISOString())
    .run();
  return (r.meta.changes ?? 0) > 0;
}

/**
 * 人工解除拒收：把這個信箱的指定原因從拒收名單拿掉（例：對方換了信箱主機、誤判的退信）。
 * 原因一定要明講（不給預設），避免一次把檢舉也解掉。回傳實際拿掉的原因。
 * 郵差自己的拒收名單（例 Resend 後台）不在這裡，要另外去郵差那邊解。
 */
export async function removeSuppression(db: Db, email: string, reasons: SuppressionReason[]): Promise<SuppressionReason[]> {
  const addr = email.trim().toLowerCase();
  const removed: SuppressionReason[] = [];
  for (const reason of reasons) {
    // 電子報被檢舉記成 unsubscribe（detail 以 complaint 開頭）：只寫 unsubscribe 解不掉，要連 complaint 一起明講，免得把檢舉者當成一般「全部不要」的人放回來。
    const guard = reason === 'unsubscribe' && !reasons.includes('complaint') ? " AND (detail IS NULL OR detail NOT LIKE 'complaint%')" : '';
    const r = await db.prepare(`DELETE FROM suppressions WHERE email = ? AND reason = ?${guard}`).bind(addr, reason).run();
    if ((r.meta.changes ?? 0) > 0) removed.push(reason);
  }
  return removed;
}

/**
 * 走公開網址（帶鑰匙）的站的速度上限：每分鐘 perMinute、每天 perDay 次請求。
 * 用意＝鑰匙外洩時，別人拿它也寄不了多少。計數用一條 SQL 加一並讀回（原子），同時打進 N 個請求也擋得住。
 * 算的是「請求次數」不是寄出封數（被拒的也算），寧可保守。內線（同帳號）不受限。0 或不合法＝該窗不限。
 * 回傳超過的那個窗（'minute'／'day'），沒超過回 null。
 */
export async function takeRate(db: Db, site: string, limits: { perMinute: number; perDay: number }, now = new Date()): Promise<'minute' | 'day' | null> {
  const iso = now.toISOString();
  const windows: Array<['minute' | 'day', string, number]> = [
    ['minute', `m:${iso.slice(0, 16)}`, limits.perMinute],
    ['day', `d:${iso.slice(0, 10)}`, limits.perDay],
  ];
  for (const [name, win, limit] of windows) {
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const row = await db
      .prepare('INSERT INTO rate_counters (site, win, n) VALUES (?, ?, 1) ON CONFLICT (site, win) DO UPDATE SET n = n + 1 RETURNING n')
      .bind(site, win)
      .first<{ n: number }>();
    if (Number(row?.n ?? 0) > limit) return name;
  }
  return null;
}

/** 速度上限設定：沒設、空白或不合法＝預設；只接受 ≥0 的整數，明寫 0＝不限。 */
export function limitVar(v: unknown, fallback: number): number {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 ? v : fallback;
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return fallback;
  return Number(v.trim());
}

/**
 * 請求內文大小檢查（看 content-length 標頭）：沒帶、亂碼或超過上限都不收。
 * 回 'missing'（應回 411）、'too_large'（應回 413）或 null（可以讀）。
 */
export function bodySizeProblem(contentLength: string | null, max: number): 'missing' | 'too_large' | null {
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return 'missing';
  return Number(contentLength.trim()) > max ? 'too_large' : null;
}

/** 指定時差的日期 YYYY-MM-DD（預設 UTC；時差夾在 ±14 小時內）。 */
export function localDay(d: Date, offsetHours: unknown = 0): string {
  const n = typeof offsetHours === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(offsetHours) ? Number(offsetHours) : offsetHours;
  const h = typeof n === 'number' && Number.isFinite(n) ? Math.max(-14, Math.min(14, n)) : 0;
  return new Date(d.getTime() + h * 3_600_000).toISOString().slice(0, 10);
}

/** 舊的計數窗清掉（兩天前以前）；由 /v1/send（約每 100 次）與管理入口（約每 20 次）順手呼叫。 */
export async function pruneRate(db: Db, now = new Date()): Promise<void> {
  const cutoff = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  await db.prepare("DELETE FROM rate_counters WHERE (win LIKE 'm:%' AND win < ?) OR (win LIKE 'd:%' AND win < ?)").bind(`m:${cutoff.slice(0, 16)}`, `d:${cutoff.slice(0, 10)}`).run();
}

/**
 * 走公開網址的站的寄件白名單檢查。該站沒列白名單＝拒收（'allowlist_required'）；
 * 有列但這封的寄件人不在內＝'from_not_allowed'；通過回 null。
 */
export function checkHttpFrom(table: Record<string, string[]> | undefined, site: string, rawFrom: unknown): 'allowlist_required' | 'from_not_allowed' | null {
  const allowed = table?.[site];
  if (!Array.isArray(allowed) || allowed.length === 0) return 'allowlist_required';
  const from = parseAddress(String(rawFrom ?? ''));
  if (!from || !allowed.map((a) => String(a).toLowerCase()).includes(from.addr)) return 'from_not_allowed';
  return null;
}

/** 帳本保存天數設定：沒設、空白或不合法＝null（不自動清）；只接受 ≥1 的整數（0 不算，避免誤設成把帳本全清）。 */
export function retentionDays(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * 清掉超過保存天數的帳本列（messages 看 created_at、webhook_events 看 received_at）。
 * 「正在寄」的列不動；拒收名單不清（那是防線不是紀錄）。一次最多清 limit 列，沒清完下一輪排程接著清。
 * 回傳實際刪掉的列數。
 */
/** 電子報的帳本列至少留這麼多天（去重與網域滾動比率都靠它；保存天數設得再短也不清）。 */
export const MIN_MARKETING_RETENTION_DAYS = 400;

export async function purgeLedger(db: Db, days: number, now = new Date(), limit = 5000): Promise<{ messages: number; webhookEvents: number }> {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const marketingCutoff = new Date(now.getTime() - Math.max(days, MIN_MARKETING_RETENTION_DAYS) * 86_400_000).toISOString();
  const m = await db
    .prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE created_at < ? AND status != 'sending' AND (stream != 'marketing' OR created_at < ?) ORDER BY id LIMIT ?)")
    .bind(cutoff, marketingCutoff, limit)
    .run();
  const w = await db
    .prepare('DELETE FROM webhook_events WHERE id IN (SELECT id FROM webhook_events WHERE received_at < ? LIMIT ?)')
    .bind(cutoff, limit)
    .run();
  return { messages: m.meta.changes ?? 0, webhookEvents: w.meta.changes ?? 0 };
}

export async function lookup(db: Db, site: string, key: string): Promise<MessageRow | null> {
  return db.prepare('SELECT * FROM messages WHERE site = ? AND dedupe_key = ?').bind(site, key).first<MessageRow>();
}

export async function send(deps: CoreDeps, req: SendRequest, opts: { forceInvalidResend?: boolean; routes?: readonly MailRoute[] } = {}): Promise<SendResult> {
  const tier: Tier = req && typeof req === 'object' && req.tier !== undefined ? req.tier : 'notify';
  if (!TIERS.includes(tier)) return { status: 'rejected', retryable: false, reason: 'bad_tier' };
  const bad = validate(req, domainFor(deps, tier));
  if (bad) return { status: 'rejected', retryable: false, reason: bad };
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const iso = now.toISOString();
  const stream: Stream = req.stream ?? 'transactional';
  const to = req.to.trim().toLowerCase();
  // 驗過才重組，原字串不往外送。
  const from = formatAddress(parseAddress(req.from)!);
  const replyTo = req.replyTo === undefined ? undefined : formatAddress(parseAddress(req.replyTo)!);

  // 1. 拒收名單：照樣記一列（查得到「為什麼沒寄」），不交郵差。
  const blocked = await suppressedReason(db, to, stream);

  // 2. 搶這把去重鍵：沒寄過、上次失敗／被擋、或「正在寄」已經放太久，才輪得到這次。
  const staleBefore = new Date(now.getTime() - STALE_SENDING_MS).toISOString();
  const status = blocked ? 'suppressed' : 'sending';
  const claimed = await db
    .prepare(
      `INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, error, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (site, dedupe_key) DO UPDATE SET
         status = excluded.status, error = excluded.error, attempts = messages.attempts + 1, updated_at = excluded.updated_at,
         last_error = COALESCE(messages.error, messages.last_error),
         to_email = excluded.to_email, from_addr = excluded.from_addr, subject = excluded.subject, tier = excluded.tier
       WHERE messages.status IN ('failed', 'suppressed') OR (messages.status = 'sending' AND messages.updated_at < ?)
       RETURNING id`,
    )
    .bind(stream, tier, req.site, req.key, req.kind ?? null, to, from, req.subject, status, blocked ? `suppressed:${blocked}` : null, iso, iso, staleBefore)
    .first<{ id: number }>();

  if (!claimed) {
    const existing = await lookup(db, req.site, req.key);
    if (existing?.status === 'sent') return { status: 'duplicate', retryable: false, route: (existing.route as MailRoute) ?? undefined, id: existing.id };
    return { status: 'in_flight', retryable: true, id: existing?.id };
  }
  if (blocked) return { status: 'suppressed', retryable: false, id: claimed.id, reason: blocked };

  // 3. 交郵差。
  const tierKeys = deps.tierKeys?.[tier] ?? deps.keys;
  const keys: TransportKeys = opts.forceInvalidResend ? { ...tierKeys, resend: 're_invalid_drill_key' } : tierKeys;
  const routes = opts.routes ?? routeFor(deps.routes, req.site, tier);
  const out = await deliver(keys, { from, to, subject: req.subject, html: req.html, text: req.text, replyTo }, await idempotencyKeyFor(req.site, req.key), deps.fetcher, routes);

  // 4. 記帳。
  const done = (deps.now ?? (() => new Date()))().toISOString();
  if (out.ok) {
    await db
      .prepare("UPDATE messages SET status = 'sent', route = ?, provider_id = ?, error = NULL, updated_at = ?, sent_at = ? WHERE id = ?")
      .bind(out.route, out.providerId ?? null, done, done, claimed.id)
      .run();
    return { status: 'sent', retryable: false, route: out.route, id: claimed.id };
  }
  if (out.suppressed) {
    // 郵差（Cloudflare）自己的拒收名單擋下：不換郵差、不重試；原因不明，不寫進我們的拒收名單。
    await db.prepare("UPDATE messages SET status = 'suppressed', error = ?, updated_at = ? WHERE id = ?").bind(out.error ?? 'provider_suppressed', done, claimed.id).run();
    return { status: 'suppressed', retryable: false, id: claimed.id, reason: 'provider_suppressed' };
  }
  await db.prepare("UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind(out.error ?? 'unknown', done, claimed.id).run();
  console.error('mail failed', req.site, req.kind ?? '-', out.error);
  return { status: 'failed', retryable: true, id: claimed.id, reason: out.error };
}
