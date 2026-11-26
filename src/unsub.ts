// 退訂：退訂券（簽章、驗證）、一鍵退訂標頭、退訂頁與端點（RFC 8058）、收信退訂（mailto）。
// 不 import cloudflare:*，測試用 Node 內建 SQLite 跑同一份 SQL。簽章鑰匙與頁面文字都由呼叫端注入，這裡不放任何值。
//
// 規則：
// - 退訂券＝這個人在這份名單的一張憑證：不含信箱明文、不設期限；GET 只顯示確認頁，POST 才生效（信箱的資安掃描器會預先點連結）。
// - 退訂只動這一份名單（list_members），不碰別份、不碰全域拒收（suppressions）。

import { type Db } from './core.ts';
import { normalizeEmail, type ListDb } from './lists.ts';

// ---------- 退訂券 ----------

export interface UnsubClaims {
  list: string;
  contactId: number;
  /** 這封信是哪一期（選填，只用來歸因，不影響驗證）。 */
  campaign?: string | null;
}

const LIST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CAMPAIGN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const ID36 = /^[0-9a-z]{1,13}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_FORMAT = '1';
const MIN_SECRET = 16;
/** 在一段文字（例如收到的退訂信主旨）裡找退訂券。 */
const TOKEN_IN_TEXT = /(?<![A-Za-z0-9._-])1\.[a-z0-9][a-z0-9-]{0,39}\.[0-9a-z]{1,13}\.[A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9._-])/;

/** 退訂券鑰匙：第一把用來簽，全部都能驗（換鑰匙時把舊的放後面，過了過渡期再拿掉）。 */
export type UnsubSecrets = readonly string[];

/** 把設定裡的鑰匙字串整理成清單（現用一把；舊鑰匙用逗號分隔，可留空）。 */
export function unsubSecrets(current: string | undefined, previous?: string | undefined): UnsubSecrets {
  const prev = (previous ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [current ?? '', ...prev].map((s) => s.trim()).filter(Boolean);
}

const b64url = (bytes: ArrayBuffer): string => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const hmacKey = (secret: string, usage: 'sign' | 'verify') =>
  crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

/** 簽一張退訂券。沒有鑰匙或鑰匙太短＝丟錯（設定問題要大聲，不能簽出弱券）。 */
export async function signUnsubToken(secrets: UnsubSecrets, claims: UnsubClaims): Promise<string> {
  const secret = secrets[0];
  if (!secret || secret.length < MIN_SECRET) throw new Error('unsub_secret_missing_or_short');
  if (typeof claims.list !== 'string' || !LIST_ID.test(claims.list)) throw new Error('bad_list');
  if (!Number.isSafeInteger(claims.contactId) || claims.contactId < 1) throw new Error('bad_contact');
  const campaign = claims.campaign ? claims.campaign : '-';
  if (campaign !== '-' && !CAMPAIGN_ID.test(campaign)) throw new Error('bad_campaign');
  const payload = [TOKEN_FORMAT, claims.list, claims.contactId.toString(36), campaign].join('.');
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(payload));
  return `${payload}.${b64url(sig)}`;
}

/** 驗退訂券；任何一步不對（格式、簽章、鑰匙都不符）都回 null，不說哪裡錯。 */
export async function verifyUnsubToken(secrets: UnsubSecrets, token: unknown): Promise<UnsubClaims | null> {
  if (typeof token !== 'string' || token.length > 160) return null;
  const parts = token.split('.');
  if (parts.length !== 5) return null;
  const [fmt, list, id36, campaign, sig] = parts;
  if (fmt !== TOKEN_FORMAT || !LIST_ID.test(list) || !ID36.test(id36) || !SIG.test(sig)) return null;
  if (campaign !== '-' && !CAMPAIGN_ID.test(campaign)) return null;
  const contactId = parseInt(id36, 36);
  if (!Number.isSafeInteger(contactId) || contactId < 1) return null;
  const payload = parts.slice(0, 4).join('.');
  const sigBytes = fromB64url(sig);
  // 簽章的最後一個字元有幾個位元用不到，改它不會改變簽章內容；只收標準寫法，一張券只有一種長相。
  if (b64url(sigBytes.buffer) !== sig) return null;
  for (const secret of secrets) {
    if (!secret || secret.length < MIN_SECRET) continue;
    // crypto.subtle.verify 是定時比對。
    if (await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), sigBytes, new TextEncoder().encode(payload))) {
      return { list, contactId, campaign: campaign === '-' ? null : campaign };
    }
  }
  return null;
}

/** 在文字裡找退訂券（不驗證）；找不到回 null。 */
export function findUnsubToken(text: string): string | null {
  return TOKEN_IN_TEXT.exec(String(text ?? ''))?.[0] ?? null;
}

// ---------- 給產信模組帶進連結與標頭 ----------

export interface UnsubLinkConfig {
  /** 退訂網址的開頭（不含結尾斜線），例 https://u.example.com。 */
  baseUrl: string;
  /** 收退訂信的地址，例 unsubscribe@mail.example.com。沒給＝不產 mailto。 */
  mailtoAddress?: string;
}
export interface UnsubLinks {
  token: string;
  /** 退訂頁網址（頁尾連結與 List-Unsubscribe 用）。 */
  url: string;
  /** `mailto:地址?subject=券`；沒設地址＝null。 */
  mailto: string | null;
  /** 兩個一鍵退訂標頭，可直接放進寄信的 headers。 */
  headers: { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** 一位收件人的退訂連結與標頭。回傳的 url／mailto 對應 compose 的 `unsubscribe_url`／`unsubscribe_mailto`。 */
export async function unsubscribeLinks(secrets: UnsubSecrets, cfg: UnsubLinkConfig, claims: UnsubClaims): Promise<UnsubLinks> {
  const base = String(cfg?.baseUrl ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[^\s<>",]+$/i.test(base)) throw new Error('unsub_base_url_must_be_https');
  const token = await signUnsubToken(secrets, claims);
  const url = `${base}/u/${token}`;
  let mailto: string | null = null;
  if (cfg.mailtoAddress) {
    if (!/^[^\s<>",@]+@[^\s<>",@]+$/.test(cfg.mailtoAddress)) throw new Error('bad_mailto_address');
    mailto = `mailto:${cfg.mailtoAddress}?subject=${token}`;
  }
  return {
    token,
    url,
    mailto,
    headers: { 'List-Unsubscribe': mailto ? `<${url}>, <${mailto}>` : `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

// ---------- 退訂動作 ----------

export const REASONS = ['too_many', 'not_relevant', 'never_subscribed', 'other'] as const;
export type UnsubReason = (typeof REASONS)[number];
/** 退訂後這段時間內可以用同一張券反悔（天）。 */
export const RESUBSCRIBE_DAYS = 30;
/** 可以反悔的退訂來源：讀者自己按的；檢舉、匯入、人工 API 的不行。 */
const SELF_SOURCES = ['link', 'one_click', 'mailto'];

const isoNow = (now?: () => Date) => (now ?? (() => new Date()))().toISOString();

export type UnsubOutcome = { status: 'unsubscribed'; listName: string | null } | { status: 'not_found' };

/**
 * 憑券退訂這一份名單。已經退訂＝回同樣的結果、不改原本的時間與來源（重複點擊安全）；
 * 已退訂後才補選的原因，只在原本沒有原因時補上。券驗證由呼叫端先做。
 */
export async function unsubscribeByClaims(db: Db, claims: UnsubClaims, source: 'link' | 'one_click' | 'mailto', reason?: UnsubReason | null, now?: () => Date): Promise<UnsubOutcome> {
  const t = isoNow(now);
  const row = await db
    .prepare(
      `UPDATE list_members SET
         unsubscribed_at = CASE WHEN status = 'unsubscribed' THEN unsubscribed_at ELSE ? END,
         unsub_source = CASE WHEN status = 'unsubscribed' THEN unsub_source ELSE ? END,
         unsub_reason = CASE WHEN status = 'unsubscribed' THEN COALESCE(unsub_reason, ?) ELSE ? END,
         updated_at = CASE WHEN status = 'unsubscribed' THEN updated_at ELSE ? END,
         status = 'unsubscribed'
       WHERE list_id = ? AND contact_id = ?
       RETURNING contact_id`,
    )
    .bind(t, source, reason ?? null, reason ?? null, t, claims.list, claims.contactId)
    .first();
  if (!row) return { status: 'not_found' };
  const list = await db.prepare('SELECT name FROM lists WHERE id = ?').bind(claims.list).first<{ name: string }>();
  return { status: 'unsubscribed', listName: list?.name ?? null };
}

export type ResubscribeOutcome = { status: 'resubscribed' | 'already' | 'expired' | 'blocked' | 'not_found'; listName?: string | null };

/**
 * 反悔：同一張券在退訂後 30 天內可以訂回來。只限讀者自己按的退訂；檢舉、匯入、人工退訂的不行；全域拒收中的不行。
 */
export async function resubscribeByClaims(db: Db, claims: UnsubClaims, now?: () => Date): Promise<ResubscribeOutcome> {
  const nowDate = (now ?? (() => new Date()))();
  const t = nowDate.toISOString();
  const cutoff = new Date(nowDate.getTime() - RESUBSCRIBE_DAYS * 86_400_000).toISOString();
  const list = await db.prepare('SELECT name FROM lists WHERE id = ?').bind(claims.list).first<{ name: string }>();
  const listName = list?.name ?? null;
  const cur = await db
    .prepare('SELECT m.status AS status, c.email AS email FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND m.contact_id = ?')
    .bind(claims.list, claims.contactId)
    .first<{ status: string; email: string }>();
  if (!cur) return { status: 'not_found', listName };
  if (cur.status === 'subscribed') return { status: 'already', listName };
  const blocked = await db.prepare("SELECT 1 AS x FROM suppressions WHERE email = ? AND reason IN ('hard_bounce', 'complaint', 'unsubscribe') LIMIT 1").bind(cur.email).first();
  if (blocked) return { status: 'blocked', listName };
  const row = await db
    .prepare(
      `UPDATE list_members SET status = 'subscribed', unsubscribed_at = NULL, unsub_source = NULL, unsub_reason = NULL, updated_at = ?
        WHERE list_id = ? AND contact_id = ? AND status = 'unsubscribed' AND unsub_source IN (${SELF_SOURCES.map(() => '?').join(',')}) AND unsubscribed_at >= ?
        RETURNING contact_id`,
    )
    .bind(t, claims.list, claims.contactId, ...SELF_SOURCES, cutoff)
    .first();
  return { status: row ? 'resubscribed' : 'expired', listName };
}

// ---------- 退訂頁文字（可設定；引擎只放中性英文範例） ----------

/** 文字裡的 {list} 會換成名單名稱（已跳脫）。品牌語氣放私有設定，用 UNSUB_PAGE 蓋掉想改的欄位即可。 */
export interface UnsubPageText {
  lang: string;
  confirmTitle: string;
  confirmBody: string;
  confirmButton: string;
  reasonLegend: string;
  reasons: Record<UnsubReason, string>;
  doneTitle: string;
  doneBody: string;
  resubscribeLead: string;
  resubscribeButton: string;
  resubscribedTitle: string;
  resubscribedBody: string;
  resubscribeFailedTitle: string;
  resubscribeFailedBody: string;
  invalidTitle: string;
  invalidBody: string;
  retryTitle: string;
  retryBody: string;
  /** 額外的 CSS（放在 <style> 裡）。頁面只用這一段內嵌樣式，沒有 script。 */
  css: string;
}

export const DEFAULT_PAGE_TEXT: UnsubPageText = {
  lang: 'en',
  confirmTitle: 'Unsubscribe from {list}?',
  confirmBody: 'You will stop receiving {list}. This does not affect other emails you asked for.',
  confirmButton: 'Confirm unsubscribe',
  reasonLegend: 'Why are you leaving? (optional)',
  reasons: { too_many: 'Too many emails', not_relevant: 'Not relevant to me', never_subscribed: 'I never signed up', other: 'Something else' },
  doneTitle: 'You are unsubscribed',
  doneBody: 'You will no longer receive {list}.',
  resubscribeLead: 'Pressed it by mistake?',
  resubscribeButton: 'Subscribe again',
  resubscribedTitle: 'Welcome back',
  resubscribedBody: 'You are subscribed to {list} again.',
  resubscribeFailedTitle: 'Could not subscribe you again',
  resubscribeFailedBody: 'This link can no longer restore your subscription. Please sign up again from the website.',
  invalidTitle: 'This link is not valid',
  invalidBody: 'Please reply to the email you received and ask to be unsubscribed.',
  retryTitle: 'Please try again shortly',
  retryBody: 'Something went wrong on our side. Your request was not saved; please try again in a few minutes.',
  css: '',
};

/** 把設定（JSON 字串或物件）裡寫的欄位蓋到預設上；讀不懂的欄位跳過、型別不對的不收。 */
export function pageText(override?: Partial<UnsubPageText> | string | null): UnsubPageText {
  let o: unknown = override;
  if (typeof o === 'string') {
    try { o = JSON.parse(o); } catch { o = null; }
  }
  const out: UnsubPageText = { ...DEFAULT_PAGE_TEXT, reasons: { ...DEFAULT_PAGE_TEXT.reasons } };
  if (!o || typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === 'reasons' && v && typeof v === 'object') {
      for (const r of REASONS) if (typeof (v as Record<string, unknown>)[r] === 'string') out.reasons[r] = (v as Record<string, string>)[r];
    } else if (k in DEFAULT_PAGE_TEXT && k !== 'reasons' && typeof v === 'string') {
      (out as unknown as Record<string, string>)[k] = v;
    }
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fill = (s: string, listName: string | null) => esc(s).replace(/\{list\}/g, esc(listName ?? ''));
const BASE_CSS = 'body{font:16px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#222}button{font:inherit;padding:.5rem 1rem;cursor:pointer}fieldset{border:0;padding:0;margin:1rem 0}label{display:block}';

function page(text: UnsubPageText, status: number, title: string, bodyHtml: string): Response {
  const css = BASE_CSS + (text.css ?? '').replace(/<\/style/gi, '');
  const html = `<!doctype html><html lang="${esc(text.lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${css}</style></head><body><h1>${title}</h1>${bodyHtml}</body></html>`;
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // 網址裡有券：不外洩給其他網站、不被搜尋引擎收、頁面不能載入任何外部東西或執行 script。
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

// ---------- HTTP 端點 ----------

export interface UnsubHandlerConfig {
  secrets: UnsubSecrets;
  text?: UnsubPageText;
  now?: () => Date;
  /** 券驗不過時呼叫（例：轉到管理員通知）。收到原始券字串；失敗不影響回應。 */
  onInvalidToken?: (token: string, via: 'page' | 'mailto') => void | Promise<void>;
  /** 退訂成功（第一次或重複）後呼叫，給呼叫端記事件或通知；失敗不影響回應。 */
  onUnsubscribed?: (info: { claims: UnsubClaims; source: 'link' | 'one_click' | 'mailto'; reason: UnsubReason | null }) => void | Promise<void>;
}

const MAX_FORM_BYTES = 4096;
const PATH = /^\/u\/([^/]+)(\/resubscribe)?\/?$/;

async function safely(fn: (() => void | Promise<void>) | undefined) {
  if (!fn) return;
  try { await fn(); } catch (e) { console.error('unsub hook failed', e instanceof Error ? e.message : 'unknown'); }
}

/**
 * 退訂端點：GET /u/{券}（確認頁，不退訂）、POST /u/{券}（按鈕或信箱商的一鍵退訂）、POST /u/{券}/resubscribe（反悔）。
 * 路徑不是 /u/… 就回 null，交給後面的路由。
 */
export async function handleUnsubRequest(db: Db, cfg: UnsubHandlerConfig, request: Request): Promise<Response | null> {
  const url = new URL(request.url);
  const m = PATH.exec(url.pathname);
  if (!m) return null;
  const text = cfg.text ?? DEFAULT_PAGE_TEXT;
  const resub = !!m[2];
  const method = request.method.toUpperCase();
  if (method !== 'POST' && !(method === 'GET' && !resub) && method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: resub ? 'POST' : 'GET, HEAD, POST' } });
  }
  if (!cfg.secrets.some((s) => s && s.length >= MIN_SECRET)) {
    console.error('unsub secret not configured');
    return page(text, 503, fill(text.retryTitle, null), `<p>${fill(text.retryBody, null)}</p>`);
  }
  let token: string;
  try { token = decodeURIComponent(m[1]); } catch { token = ''; }
  const claims = await verifyUnsubToken(cfg.secrets, token);
  if (!claims) {
    await safely(() => cfg.onInvalidToken?.(token.slice(0, 200), 'page'));
    return page(text, 404, fill(text.invalidTitle, null), `<p>${fill(text.invalidBody, null)}</p>`);
  }

  try {
    if (method !== 'POST') {
      // GET／HEAD：只顯示確認頁，什麼都不寫。
      const row = await db.prepare('SELECT name FROM lists WHERE id = ?').bind(claims.list).first<{ name: string }>();
      const name = row?.name ?? null;
      const reasons = REASONS.map((r) => `<label><input type="radio" name="reason" value="${r}"> ${esc(text.reasons[r])}</label>`).join('');
      const form = `<form method="post" action="/u/${esc(token)}"><fieldset><legend>${fill(text.reasonLegend, name)}</legend>${reasons}</fieldset><button type="submit">${fill(text.confirmButton, name)}</button></form>`;
      return page(text, 200, fill(text.confirmTitle, name), `<p>${fill(text.confirmBody, name)}</p>${form}`);
    }

    if (resub) {
      const r = await resubscribeByClaims(db, claims, cfg.now);
      if (r.status === 'resubscribed' || r.status === 'already') return page(text, 200, fill(text.resubscribedTitle, r.listName ?? null), `<p>${fill(text.resubscribedBody, r.listName ?? null)}</p>`);
      return page(text, r.status === 'not_found' ? 404 : 409, fill(text.resubscribeFailedTitle, r.listName ?? null), `<p>${fill(text.resubscribeFailedBody, r.listName ?? null)}</p>`);
    }

    // POST：內文很小；超過上限直接拒（沒有合法的表單會這麼大）。
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAX_FORM_BYTES) return new Response('Payload too large', { status: 413 });
    const raw = (await request.text()).slice(0, MAX_FORM_BYTES);
    const form = new URLSearchParams(raw);
    const oneClick = form.get('List-Unsubscribe') === 'One-Click';
    const picked = form.get('reason');
    const reason = !oneClick && picked && (REASONS as readonly string[]).includes(picked) ? (picked as UnsubReason) : null;
    const source = oneClick ? 'one_click' : 'link';
    const r = await unsubscribeByClaims(db, claims, source, reason, cfg.now);
    await safely(() => cfg.onUnsubscribed?.({ claims, source, reason }));
    const name = r.status === 'unsubscribed' ? r.listName : null;
    // 券是真的但名單裡沒這個人（已被移除）：對讀者來說結果相同，一樣顯示已退訂。
    const again = `<form method="post" action="/u/${esc(token)}/resubscribe"><p>${fill(text.resubscribeLead, name)}</p><button type="submit">${fill(text.resubscribeButton, name)}</button></form>`;
    return page(text, 200, fill(text.doneTitle, name), `<p>${fill(text.doneBody, name)}</p>${again}`);
  } catch (e) {
    // 資料庫寫不進去：回 503，信箱商會重試一鍵退訂；手動按的人看到「請稍後再試」。
    console.error('unsub failed', e instanceof Error ? e.message : 'unknown');
    return page(text, 503, fill(text.retryTitle, null), `<p>${fill(text.retryBody, null)}</p>`);
  }
}

// ---------- 收信退訂（mailto） ----------

export interface UnsubMail {
  /** 信封寄件人（只用來記錄，不用來判斷是誰）。 */
  from?: string;
  subject?: string | null;
}
export type UnsubMailOutcome = 'unsubscribed' | 'invalid_token' | 'no_token' | 'failed';

/**
 * Cloudflare Email Routing 轉進 Worker `email()` 的退訂信：主旨帶退訂券就退訂（來源 mailto），沒券的由呼叫端的
 * onNoToken 轉人工。不回信（避免信件迴圈），不讀信件本文。
 */
export async function handleUnsubMail(db: Db, cfg: UnsubHandlerConfig & { onNoToken?: (mail: UnsubMail) => void | Promise<void> }, mail: UnsubMail): Promise<UnsubMailOutcome> {
  const token = findUnsubToken(String(mail?.subject ?? ''));
  if (!token) {
    await safely(() => cfg.onNoToken?.(mail));
    return 'no_token';
  }
  const claims = await verifyUnsubToken(cfg.secrets, token);
  if (!claims) {
    await safely(() => cfg.onInvalidToken?.(token, 'mailto'));
    return 'invalid_token';
  }
  try {
    await unsubscribeByClaims(db, claims, 'mailto', null, cfg.now);
  } catch (e) {
    console.error('unsub mail failed', e instanceof Error ? e.message : 'unknown');
    return 'failed';
  }
  await safely(() => cfg.onUnsubscribed?.({ claims, source: 'mailto', reason: null }));
  return 'unsubscribed';
}

// ---------- 取得某人的退訂連結（給寄送端／內線用） ----------

/** 用信箱找出聯絡人再產連結；信箱不在 contacts ＝回 null。大量寄送時寄送端手上已有 contact id，直接呼叫 unsubscribeLinks。 */
export async function unsubscribeLinksForEmail(db: ListDb, secrets: UnsubSecrets, cfg: UnsubLinkConfig, input: { list: string; email: string; campaign?: string | null }): Promise<UnsubLinks | null> {
  const email = normalizeEmail(input?.email);
  if (!email) return null;
  const row = await db
    .prepare('SELECT m.contact_id AS id FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND c.email = ?')
    .bind(input.list, email)
    .first<{ id: number }>();
  if (!row) return null;
  return unsubscribeLinks(secrets, cfg, { list: input.list, contactId: Number(row.id), campaign: input.campaign });
}
