// 開信與點擊追蹤（自己追蹤，不用郵差的追蹤）：
//   GET|HEAD {TRACK_BASE_URL}/c/{券}      → 302 轉到這一期信裡第 N 個連結（記一筆 click）
//   GET|HEAD {TRACK_BASE_URL}/o/{券}.gif  → 1×1 透明圖（記一筆 open）
//
// 券＝「種類｜期別｜聯絡人｜連結序號」加 HMAC 簽章。轉去哪裡不寫在券裡：用期別＋序號查那一期存下的連結表，
// 所以只能轉到那一期信裡真的有的連結（不是開放轉址），也沒辦法拿券去換任意網址。
// 簽章不對、期別不存在、序號不在表裡：一律同樣的 404（不讀資料庫就先擋掉偽造的券，也不透露哪一期、哪個人存在）。
// 事件不帶信箱（只帶期別與聯絡人編號）。寫事件在回應之後做（waitUntil），寫失敗也照樣轉址。
// 聯絡人 0＝測試信：照樣轉址、不記事件。
//
// 規則與依據見 docs/tracking.md。

import { detectScannerClicks, type ClickEvent } from './compose/clicks.ts';
import { scrubEmails } from './export.ts';
import type { Db } from './core.ts';

export type TrackKind = 'c' | 'o';

export interface TrackSettings {
  /** 寄出後幾毫秒內、同一封信點了幾個不同連結就標成掃描器（同 detectScannerClicks）。 */
  scannerWindowMs: number;
  scannerMinLinks: number;
  /** 來源網路（ASN）在這份清單裡的點擊直接標成掃描器。預設空：企業代理與雲端桌面的真人也可能從這些網路來，要自己評估。 */
  scannerAsns: number[];
  /** 來源網路在這份清單裡的開信標 prefetch=true。預設 [714]（Apple 的網路；Apple 郵件隱私保護的預載從 Apple 的代理伺服器發出）。 */
  prefetchAsns: number[];
  /** User-Agent 含這些字（不分大小寫）的開信也標 prefetch=true。預設空。 */
  prefetchUserAgents: string[];
  /** 同一人同一期同一連結，幾秒內的重複點擊只記一筆（預設 60）。 */
  clickDedupeSeconds: number;
  /** 同一人同一期，幾秒內的重複開信只記一筆（預設 3600；預載與非預載分開算）。 */
  openDedupeSeconds: number;
  /** 帳本裡電子報那類的站名（＝群發設定的 site），用來對到這封信的帳本列。 */
  site: string;
}

export const DEFAULT_TRACK_SETTINGS: Readonly<TrackSettings> = Object.freeze({
  scannerWindowMs: 60_000,
  scannerMinLinks: 3,
  scannerAsns: [],
  prefetchAsns: [714],
  prefetchUserAgents: [],
  clickDedupeSeconds: 60,
  openDedupeSeconds: 3600,
  site: 'newsletter',
});

const CAMPAIGN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TOKEN = /^[A-Za-z0-9_-]{4,120}\.[A-Za-z0-9_-]{22}$/;
const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    keyCache.set(secret, k);
  }
  return k;
}

async function mac(secret: string, payload: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(`mailroom-track:v1:${payload}`));
  return new Uint8Array(sig).slice(0, 16);
}

/** 追蹤鑰匙：第一把簽新券，其餘只驗證（換鑰匙過渡期）。每把至少 16 字元，太短的丟掉。 */
export function trackSecrets(current?: string, previous?: string): string[] {
  // 目前的鑰匙沒設或太短＝追蹤關閉（不能讓舊鑰匙補位去簽新券：換鑰匙常常就是因為舊的外洩了）。
  const cur = (current ?? '').trim();
  if (cur.length < 16) return [];
  return [cur, ...(previous ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 16)];
}

export interface TrackClaim { kind: TrackKind; campaign: string; contact: number; index: number | null }

/** 簽一張券。index 只給點擊（1 起算）。 */
export async function signTrack(secret: string, claim: TrackClaim): Promise<string> {
  if (!CAMPAIGN.test(claim.campaign) || !Number.isInteger(claim.contact) || claim.contact < 0) throw new Error('bad track claim');
  if (claim.kind === 'c' ? !Number.isInteger(claim.index) || (claim.index as number) < 1 : claim.index !== null) throw new Error('bad track claim');
  const payload = [claim.kind, claim.campaign, String(claim.contact), claim.kind === 'c' ? String(claim.index) : ''].join('|');
  return `${b64url(enc.encode(payload))}.${b64url(await mac(secret, payload))}`;
}

/** 驗券：任何一把鑰匙對得上才回內容；格式、簽章、內容有一點不對就回 null。 */
export async function verifyTrack(secrets: readonly string[], token: string, kind: TrackKind): Promise<TrackClaim | null> {
  if (!secrets.length || typeof token !== 'string' || !TOKEN.test(token)) return null;
  const [p, s] = token.split('.');
  const raw = fromB64url(p);
  const sig = fromB64url(s);
  if (!raw || !sig || sig.length !== 16) return null;
  let payload: string;
  try {
    payload = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw);
  } catch {
    return null;
  }
  let ok = false;
  for (const secret of secrets) {
    const want = await mac(secret, payload);
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= want[i] ^ sig[i];
    if (diff === 0) ok = true;
  }
  if (!ok) return null;
  const m = /^([co])\|([a-z0-9][a-z0-9-]{0,39})\|(0|[1-9]\d{0,14})\|(0|[1-9]\d{0,4})?$/.exec(payload);
  if (!m || m[1] !== kind) return null;
  if (kind === 'c' ? m[4] === undefined || m[4] === '0' : m[4] !== undefined) return null;
  return { kind, campaign: m[2], contact: Number(m[3]), index: kind === 'c' ? Number(m[4]) : null };
}

/**
 * 給個人化用：先把內容裡用到的 {{c:N}}、{{o}} 都簽好，回傳 personalize 要的同步函式。
 * 內容裡的序號必須在這期的連結表裡（不在＝資料壞了，丟例外讓這期暫停，不寄出點了會 404 的信）。
 */
export async function trackSigner(secret: string, campaign: string, contact: number, contents: string[], linkCount: number | null): Promise<(kind: TrackKind, index?: number) => string> {
  const indexes = new Set<number>();
  let open = false;
  for (const s of contents) {
    for (const m of s.matchAll(/\{\{\s*c:(\d+)\s*\}\}/g)) indexes.add(Number(m[1]));
    if (/\{\{\s*o\s*\}\}/.test(s)) open = true;
  }
  const signed = new Map<number, string>();
  for (const i of indexes) {
    if (linkCount !== null && (i < 1 || i > linkCount)) throw new Error(`link ${i} is not in the campaign's link table`);
    signed.set(i, await signTrack(secret, { kind: 'c', campaign, contact, index: i }));
  }
  const pixel = open ? await signTrack(secret, { kind: 'o', campaign, contact, index: null }) : '';
  return (kind, index) => {
    if (kind === 'o') return pixel;
    const t = signed.get(index as number);
    if (!t) throw new Error(`link ${index} was not signed`);
    return t;
  };
}

/** 存進 campaigns.links 的形狀：序號 → 最終網址。 */
export interface StoredLink { index: number; url: string }

/** 連結表檢查（存草稿時用）：序號 1..N 連號、網址 http(s)、不含空白控制字元、不太長。 */
export function checkLinks(v: unknown): StoredLink[] | null {
  if (!Array.isArray(v) || v.length > 500) return null;
  const out: StoredLink[] = [];
  for (const [i, x] of v.entries()) {
    if (!x || typeof x !== 'object') return null;
    const { index, url } = x as Record<string, unknown>;
    if (index !== i + 1 || typeof url !== 'string' || url.length > 2000 || !/^https?:\/\/[^\s<>"\u0000-\u001f\u007f]+$/i.test(url)) return null;
    // 存正規化後的網址（中文路徑變成 %XX、反斜線等瀏覽器會改寫的寫法先改寫好）：轉址標頭只能放 ASCII，也不留解讀不一致的空間。
    let href: string;
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      href = u.href;
    } catch {
      return null;
    }
    if (!/^[\x21-\x7e]+$/.test(href) || href.length > 2000) return null;
    out.push({ index, url: href });
  }
  return out;
}

// ---------- 端點 ----------

export interface TrackDeps {
  db: Db;
  secrets: readonly string[];
  /** 追蹤網址的 host（小寫）；請求的 host 不同就不處理（回 null 讓別的路由接）。 */
  host: string;
  settings: TrackSettings;
  /** 回應之後才做的事（Worker 的 ctx.waitUntil）。沒給＝當場等它做完（測試用）。 */
  waitUntil?: (p: Promise<unknown>) => void;
  now?: () => Date;
}

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (c) => c.charCodeAt(0));
const NO_STORE = { 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' };

function gif(head: boolean): Response {
  return new Response(head ? null : GIF, { status: 200, headers: { ...NO_STORE, 'content-type': 'image/gif', 'content-length': String(GIF.length) } });
}
function notFoundLink(): Response {
  return new Response('This link is not valid.', { status: 404, headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' } });
}

/** 一期的連結表，每個執行個體快取 5 分鐘（只快取讀到的結果；期別送出後連結表不會再變）。 */
const linkCache = new Map<string, { at: number; links: StoredLink[] | null }>();
const LINK_CACHE_MS = 300_000;

async function campaignLinks(db: Db, campaign: string, nowMs: number): Promise<StoredLink[] | null> {
  const hit = linkCache.get(campaign);
  if (hit && nowMs - hit.at < LINK_CACHE_MS) return hit.links;
  const row = await db.prepare('SELECT links FROM campaigns WHERE id = ?').bind(campaign).first<{ links: string | null }>();
  let links: StoredLink[] | null = null;
  if (row?.links) {
    try {
      links = checkLinks(JSON.parse(row.links));
    } catch {
      links = null;
    }
  }
  if (linkCache.size > 200) linkCache.clear();
  linkCache.set(campaign, { at: nowMs, links });
  return links;
}

/** 測試用：清快取。 */
export function clearTrackCache(): void {
  linkCache.clear();
}

interface RequestFacts { asn: number | null; ua: string; method: string }

function facts(request: Request): RequestFacts {
  const cf = (request as unknown as { cf?: { asn?: unknown } }).cf;
  const asn = typeof cf?.asn === 'number' && Number.isInteger(cf.asn) ? cf.asn : null;
  return { asn, ua: (request.headers.get('user-agent') ?? '').slice(0, 200), method: request.method };
}

/** 處理追蹤請求；不是追蹤網址就回 null。 */
export async function handleTrackRequest(request: Request, deps: TrackDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (!deps.secrets.length || !deps.host || url.hostname.toLowerCase() !== deps.host) return null;
  const m = /^\/(c|o)\/([^/]+)$/.exec(url.pathname);
  if (!m) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405, headers: { ...NO_STORE, allow: 'GET, HEAD' } });
  const head = request.method === 'HEAD';
  const now = (deps.now ?? (() => new Date()))();
  const later = (p: Promise<unknown>) => {
    const safe = p.catch((e) => console.error('track event write failed', e instanceof Error ? e.message.slice(0, 200) : 'unknown'));
    if (deps.waitUntil) deps.waitUntil(safe);
    return safe;
  };

  if (m[1] === 'o') {
    const token = m[2].endsWith('.gif') ? m[2].slice(0, -4) : '';
    const claim = token ? await verifyTrack(deps.secrets, token, 'o') : null;
    // HEAD 不是讀者打開信（連結檢查器之類），不記開信。
    if (claim && claim.contact > 0 && !head) {
      const p = later(recordOpen(deps, claim, facts(request), now));
      if (!deps.waitUntil) await p;
    }
    // 開信圖一律回圖（不論券對不對）：看回應分辨不出哪張券是真的。
    return gif(head);
  }

  const claim = await verifyTrack(deps.secrets, m[2], 'c');
  if (!claim) return notFoundLink();
  let links: StoredLink[] | null;
  try {
    links = await campaignLinks(deps.db, claim.campaign, now.getTime());
  } catch (e) {
    console.error('track link lookup failed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    return new Response('Temporarily unavailable, please try again.', { status: 503, headers: { ...NO_STORE, 'retry-after': '5', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const link = links?.find((l) => l.index === claim.index);
  if (!link) return notFoundLink();
  if (!/^https?:\/\/[\x21-\x7e]+$/.test(link.url)) {
    console.error('track link not ascii', claim.campaign, claim.index);
    return notFoundLink();
  }
  if (claim.contact > 0) {
    const p = later(recordClick(deps, claim, link, facts(request), now));
    if (!deps.waitUntil) await p;
  }
  return new Response(null, { status: 302, headers: { ...NO_STORE, location: link.url } });
}

// ---------- 記事件 ----------

function bucket(now: Date, seconds: number): number {
  return Math.floor(now.getTime() / 1000 / Math.max(1, seconds));
}

async function insertEvent(deps: TrackDeps, claim: TrackClaim, type: 'click' | 'open', eventId: string, detail: Record<string, unknown>, now: Date): Promise<boolean> {
  const r = await deps.db
    .prepare(
      `INSERT INTO events (provider, provider_event_id, message_id, provider_message_id, campaign_id, contact_id, type, subtype, at, detail)
       VALUES ('self', ?, (SELECT id FROM messages WHERE site = ? AND dedupe_key = ?), NULL, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT (provider_event_id) DO NOTHING`,
    )
    .bind(eventId, deps.settings.site, `c:${claim.campaign}:${claim.contact}`, claim.campaign, claim.contact, type, now.toISOString(), JSON.stringify(scrubEmails(detail)).slice(0, 2000))
    .run();
  return (r.meta.changes ?? 0) === 1;
}

async function touchMember(deps: TrackDeps, claim: TrackClaim, column: 'last_open_at' | 'last_click_at', now: Date): Promise<void> {
  await deps.db
    .prepare(`UPDATE list_members SET ${column} = ? WHERE contact_id = ? AND list_id = (SELECT list_id FROM campaigns WHERE id = ?) AND (${column} IS NULL OR ${column} < ?)`)
    .bind(now.toISOString(), claim.contact, claim.campaign, now.toISOString())
    .run();
}

export function isPrefetch(f: RequestFacts, s: TrackSettings): boolean {
  if (f.asn !== null && s.prefetchAsns.includes(f.asn)) return true;
  const ua = f.ua.toLowerCase();
  return s.prefetchUserAgents.some((p) => p && ua.includes(p.toLowerCase()));
}

async function recordOpen(deps: TrackDeps, claim: TrackClaim, f: RequestFacts, now: Date): Promise<void> {
  const prefetch = isPrefetch(f, deps.settings);
  const id = `self:o:${claim.campaign}:${claim.contact}:${prefetch ? 'p' : 'h'}:${bucket(now, deps.settings.openDedupeSeconds)}`;
  const detail: Record<string, unknown> = { ...(prefetch ? { prefetch: true } : {}), ...(f.asn !== null ? { asn: f.asn } : {}), ...(f.ua ? { ua: f.ua } : {}) };
  const inserted = await insertEvent(deps, claim, 'open', id, detail, now);
  if (inserted && !prefetch) await touchMember(deps, claim, 'last_open_at', now);
}

async function recordClick(deps: TrackDeps, claim: TrackClaim, link: StoredLink, f: RequestFacts, now: Date): Promise<void> {
  const s = deps.settings;
  const id = `self:c:${claim.campaign}:${claim.contact}:${claim.index}:${bucket(now, s.clickDedupeSeconds)}`;
  const rule = f.method === 'HEAD' ? 'head' : f.asn !== null && s.scannerAsns.includes(f.asn) ? 'asn' : null;
  const detail: Record<string, unknown> = {
    url: link.url, linkIndex: link.index,
    ...(rule ? { suspect: 'scanner', scannerRule: rule } : {}),
    ...(f.asn !== null ? { asn: f.asn } : {}), ...(f.ua ? { ua: f.ua } : {}),
  };
  const inserted = await insertEvent(deps, claim, 'click', id, detail, now);
  if (!inserted) return;
  await markBurst(deps, claim, now);
  if (!rule) {
    // 被判成掃描器的點擊不更新「最後點擊」。
    const me = await deps.db.prepare("SELECT json_extract(detail, '$.suspect') AS s FROM events WHERE provider_event_id = ?").bind(id).first<{ s: string | null }>();
    if (!me?.s) await touchMember(deps, claim, 'last_click_at', now);
  }
}

/** 寄出後的短時間內同一封信被點了好幾個不同連結：用 detectScannerClicks 的規則把這幾筆都標上 suspect='scanner'。 */
async function markBurst(deps: TrackDeps, claim: TrackClaim, now: Date): Promise<void> {
  const s = deps.settings;
  const msg = await deps.db.prepare('SELECT sent_at FROM messages WHERE site = ? AND dedupe_key = ?').bind(s.site, `c:${claim.campaign}:${claim.contact}`).first<{ sent_at: string | null }>();
  const sentAt = msg?.sent_at ? Date.parse(msg.sent_at) : NaN;
  if (Number.isNaN(sentAt) || now.getTime() - sentAt > s.scannerWindowMs) return;
  const rows = (await deps.db
    .prepare("SELECT id, at, json_extract(detail, '$.linkIndex') AS li FROM events WHERE campaign_id = ? AND contact_id = ? AND type = 'click' AND provider = 'self'")
    .bind(claim.campaign, claim.contact)
    .all<{ id: number; at: string; li: number | null }>()).results;
  const clicks: ClickEvent[] = rows.filter((r) => r.li !== null).map((r) => ({ id: String(r.id), messageId: 'm', linkIndex: Number(r.li), at: Date.parse(r.at) }));
  const flagged = detectScannerClicks(clicks, { m: sentAt }, { windowMs: s.scannerWindowMs, minDistinctLinks: s.scannerMinLinks });
  for (const id of flagged) {
    await deps.db
      .prepare("UPDATE events SET detail = json_set(COALESCE(detail, '{}'), '$.suspect', 'scanner', '$.scannerRule', COALESCE(json_extract(detail, '$.scannerRule'), 'burst')) WHERE id = ? AND json_extract(detail, '$.suspect') IS NULL")
      .bind(Number(id))
      .run();
  }
}

// ---------- 設定 ----------

function nums(v: unknown, fallback: number[]): number[] {
  return Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0 && x < 2 ** 32) ? (v as number[]) : fallback;
}
function strs(v: unknown, fallback: string[]): string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 100) ? (v as string[]) : fallback;
}
function int(v: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fallback;
}

/** 部署端的 TRACK_CONFIG（JSON，只寫想改的欄位）＋群發設定的 site。讀不懂的欄位用預設值。 */
export function resolveTrackSettings(raw: unknown, site?: string): TrackSettings {
  let o: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) o = raw as Record<string, unknown>;
  else if (typeof raw === 'string' && raw.trim()) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object' && !Array.isArray(p)) o = p;
      else console.error('TRACK_CONFIG is not an object, using defaults');
    } catch {
      console.error('TRACK_CONFIG unreadable, using defaults');
    }
  }
  const d = DEFAULT_TRACK_SETTINGS;
  return {
    scannerWindowMs: int(o.scannerWindowMs, d.scannerWindowMs, 1000, 3_600_000),
    scannerMinLinks: int(o.scannerMinLinks, d.scannerMinLinks, 2, 50),
    scannerAsns: nums(o.scannerAsns, d.scannerAsns),
    prefetchAsns: nums(o.prefetchAsns, d.prefetchAsns),
    prefetchUserAgents: strs(o.prefetchUserAgents, d.prefetchUserAgents),
    clickDedupeSeconds: int(o.clickDedupeSeconds, d.clickDedupeSeconds, 1, 86_400),
    openDedupeSeconds: int(o.openDedupeSeconds, d.openDedupeSeconds, 1, 86_400 * 7),
    site: typeof site === 'string' && site ? site : d.site,
  };
}

/** TRACK_BASE_URL → host（小寫）；不是 https 根網址＝null（追蹤關閉）。 */
export function trackHost(base: string | undefined): string | null {
  if (!base) return null;
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}
