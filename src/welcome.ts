// 歡迎信：讀者「第一次」加入某份名單時，郵務室寄一封歡迎信。走電子報那一路（電子報郵差、電子報寄件網域、退訂兩個標頭、帳本）。
//
// 什麼時候會寄（全部都要成立）：
//   1. 群發總開關開著（MARKETING_DOMAIN＋NEWSLETTER_POSTMAN＋BROADCAST Queue 都有，郵差設得起來）。關著＝一封都不寄，也不排。
//   2. 這份名單有歡迎信、而且明確打開（welcome_mails.enabled = 1）。預設關。
//   3. 這次加入是讀者本人的加入動作（listSubscribe），而且他以前從來不是這份名單的成員（firstTime）。
//      退訂後再訂回、搬家匯入、分群寫入都不寄。
//   4. 寄的當下他還訂閱中、不在拒收名單、寄件網域沒有停寄、郵差健康、今天額度還有。
//   5. 帳本去重鍵 welcome:{名單}:{聯絡人} 沒寄過（同一人最多一封，兩個加入同時進來也只寄一封）。
//
// 內容是設定：在 Worker 外面用 compose 產好（品牌樣板在自己的設定裡），用管理入口存進 welcome_mails。引擎只附範例（docs/welcome.md）。

import { parseAddress, suppressedReason, type Db } from './core.ts';
import { scanPlaceholders, personalize } from './compose/personalize.ts';
import { unsubscribeLinks } from './unsub.ts';
import type { Postman, PostmanOutcome } from './broadcast/postman.ts';
import { localDay } from './core.ts';
import { subscribeMember, type ListDb, type SubscribeInput, type SubscribeResult } from './lists.ts';

export interface WelcomeInput {
  subject: string;
  from: string;
  replyTo?: string;
  html: string;
  text: string;
  /** {{web_url}} 的值（https），例如電子報的過刊頁。 */
  webUrl: string;
  /** 一定要明講：true＝開始對新訂閱者寄、false＝存著但不寄。 */
  enabled: boolean;
}

export interface WelcomeRow {
  list_id: string; subject: string; from_addr: string; reply_to: string | null; html: string; text: string;
  web_url: string; content_hash: string; enabled: number; updated_at: string;
}

export type WelcomeMessage = { kind: 'welcome'; list: string; contact: number; queuedAt: string };

const LIST_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ctl = (s: string) => /[\u0000-\u001f\u007f]/.test(s);
/** 寄的當下暫時寄不了（網域停寄、郵差不健康、額度用完）最多等多久，過了就放棄（不補寄很舊的歡迎信）。 */
export const WELCOME_MAX_AGE_MS = 48 * 3600_000;
/** 暫時寄不了時多久後再試。 */
export const WELCOME_RETRY_SECONDS = 900;

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 檢查歡迎信內容。回錯誤代碼或 null。 */
export function checkWelcome(input: WelcomeInput, marketingDomain: string): string | null {
  if (!input || typeof input !== 'object') return 'bad_request';
  if (typeof input.enabled !== 'boolean') return 'enabled_required';
  if (typeof input.subject !== 'string' || !input.subject.trim() || Array.from(input.subject).length > 80 || ctl(input.subject)) return 'bad_subject';
  const from = parseAddress(String(input.from ?? ''));
  if (!from || !marketingDomain || !from.addr.endsWith(`@${marketingDomain.toLowerCase()}`)) return 'bad_from';
  if (input.replyTo !== undefined && !parseAddress(input.replyTo)) return 'bad_reply_to';
  if (typeof input.html !== 'string' || !input.html || input.html.length > 200_000) return 'bad_html';
  if (typeof input.text !== 'string' || !input.text || input.text.length > 100_000) return 'bad_text';
  if (typeof input.webUrl !== 'string' || input.webUrl.length > 2000 || !/^https:\/\/[^\s<>"]+$/i.test(input.webUrl)) return 'bad_web_url';
  for (const s of [input.html, input.text]) {
    const p = scanPlaceholders(s);
    if (p.unknown.length || p.unbalanced.length) return 'unknown_placeholder';
    // 歡迎信不追蹤（沒有期別的連結表）：compose 時不要給 trackBase。
    if (p.used.has('c') || p.used.has('o')) return 'tracking_not_supported';
    if (!p.used.has('unsubscribe_url')) return 'unsubscribe_link_missing';
    if (p.used.has('unsubscribe_mailto')) return 'unknown_placeholder';
  }
  return null;
}

/** 存（或改）一份名單的歡迎信。enabled 每次都要明講。 */
export async function saveWelcome(db: Db, list: string, input: WelcomeInput, opts: { marketingDomain: string; now?: () => Date }): Promise<{ ok: true; enabled: boolean; changed: boolean } | { ok: false; reason: string }> {
  if (typeof list !== 'string' || !LIST_ID.test(list)) return { ok: false, reason: 'bad_list' };
  const bad = checkWelcome(input, opts.marketingDomain);
  if (bad) return { ok: false, reason: bad };
  if (!(await db.prepare('SELECT id FROM lists WHERE id = ?').bind(list).first())) return { ok: false, reason: 'unknown_list' };
  const hash = await sha256(JSON.stringify([input.subject, input.from, input.replyTo ?? '', input.html, input.text, input.webUrl]));
  const before = await db.prepare('SELECT content_hash, enabled FROM welcome_mails WHERE list_id = ?').bind(list).first<{ content_hash: string; enabled: number }>();
  const t = (opts.now ?? (() => new Date()))().toISOString();
  await db
    .prepare(
      `INSERT INTO welcome_mails (list_id, subject, from_addr, reply_to, html, text, web_url, content_hash, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (list_id) DO UPDATE SET subject = excluded.subject, from_addr = excluded.from_addr, reply_to = excluded.reply_to, html = excluded.html,
         text = excluded.text, web_url = excluded.web_url, content_hash = excluded.content_hash, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    )
    .bind(list, input.subject, input.from, input.replyTo ?? null, input.html, input.text, input.webUrl, hash, input.enabled ? 1 : 0, t)
    .run();
  return { ok: true, enabled: input.enabled, changed: !before || before.content_hash !== hash || Boolean(before.enabled) !== input.enabled };
}

export async function getWelcome(db: Db, list: string): Promise<WelcomeRow | null> {
  if (typeof list !== 'string' || !LIST_ID.test(list)) return null;
  return db.prepare('SELECT * FROM welcome_mails WHERE list_id = ?').bind(list).first<WelcomeRow>();
}

// ---------- 排信（加入時）----------

export interface WelcomeQueue { send(body: WelcomeMessage, opts?: { delaySeconds?: number }): Promise<unknown> }

/**
 * 加入成功、而且是第一次加入時呼叫。只排進 Queue（不在讀者的加入請求裡寄信）；任何失敗都只記 log，不影響加入結果。
 * @param enabled 群發總開關（呼叫端判斷）；false＝什麼都不做。
 */
export async function queueWelcome(db: Db, queue: WelcomeQueue | undefined, enabled: boolean, list: string, contact: number, now = new Date()): Promise<'queued' | 'off' | 'no_welcome' | 'error'> {
  if (!enabled || !queue) return 'off';
  try {
    const w = await db.prepare('SELECT enabled FROM welcome_mails WHERE list_id = ?').bind(list).first<{ enabled: number }>();
    if (!w || !w.enabled) return 'no_welcome';
    await queue.send({ kind: 'welcome', list, contact, queuedAt: now.toISOString() }, { delaySeconds: 5 });
    return 'queued';
  } catch (e) {
    console.error('welcome queue failed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    return 'error';
  }
}

/**
 * 內線 listSubscribe 的實作：加入名單；第一次加入時照上面的條件排歡迎信。回給呼叫端的只有加入結果（不含聯絡人編號）。
 * @param switchOn 群發總開關（呼叫端判斷）。
 */
export async function subscribeWithWelcome(db: ListDb, input: SubscribeInput, opts: { queue?: WelcomeQueue; switchOn: boolean; now?: () => Date }): Promise<SubscribeResult> {
  const r = await subscribeMember(db, input, opts.now);
  if (r.status !== 'subscribed') return r;
  if ('contactId' in r && r.firstTime) {
    const outcome = await queueWelcome(db as unknown as Db, opts.queue, opts.switchOn, input.list, r.contactId, (opts.now ?? (() => new Date()))());
    if (outcome === 'error') console.warn('welcome not queued', input.list);
  }
  return { status: 'subscribed', firstTime: r.firstTime };
}

// ---------- 寄信（Queue 消化時）----------

export interface WelcomeDeps {
  db: ListDb;
  postman: Postman;
  /** 電子報寄件網域（小寫）。 */
  domain: string;
  /** 帳本站名（群發設定的 site）。 */
  site: string;
  utcOffsetHours: number;
  unsub: { secrets: readonly string[]; baseUrl?: string; mailto?: string };
  now?: () => Date;
}

export type WelcomeResult = { action: 'ack'; outcome: string } | { action: 'retry'; delaySeconds: number; outcome: string };
const ack = (outcome: string): WelcomeResult => ({ action: 'ack', outcome });

function fmt(a: { name: string | null; addr: string }): string {
  return a.name ? `${a.name} <${a.addr}>` : a.addr;
}

/**
 * 名字是加入的人自己填的；歡迎信是加入一發生就寄出的自動信，名字欄可以被拿來夾帶網址或網域（「請到 evil.example 領獎」）。
 * 名字裡有網址、網域、@、斜線或角括號的樣子，就當作沒有名字（整段問候拿掉）。
 */
export function safeName(name: string | null): string | null {
  if (typeof name !== 'string') return null;
  if (/[\/:@<>]|www|\.[a-z0-9-]{2,}/i.test(name)) return null;
  return name;
}

export async function consumeWelcome(deps: WelcomeDeps, msg: WelcomeMessage): Promise<WelcomeResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  if (!msg || typeof msg.list !== 'string' || !LIST_ID.test(msg.list) || !Number.isInteger(msg.contact) || msg.contact < 1) return ack('welcome_bad_message');
  const queuedAt = Date.parse(String(msg.queuedAt));
  const tooOld = Number.isNaN(queuedAt) || now.getTime() - queuedAt > WELCOME_MAX_AGE_MS;
  const later = (outcome: string): WelcomeResult => (tooOld ? ack(`welcome_expired:${outcome}`) : { action: 'retry', delaySeconds: WELCOME_RETRY_SECONDS, outcome });

  const w = await getWelcome(db as unknown as Db, msg.list);
  if (!w || !w.enabled) return ack('welcome_disabled');
  const member = await db
    .prepare('SELECT m.status AS status, c.email AS email, c.name AS name FROM list_members m JOIN contacts c ON c.id = m.contact_id WHERE m.list_id = ? AND m.contact_id = ?')
    .bind(msg.list, msg.contact)
    .first<{ status: string; email: string; name: string | null }>();
  if (!member || member.status !== 'subscribed') return ack('welcome_not_subscribed');
  if (await suppressedReason(db as unknown as Db, member.email, 'marketing')) return ack('welcome_suppressed');
  const key = `welcome:${msg.list}:${msg.contact}`;
  const done = await db.prepare("SELECT status FROM messages WHERE site = ? AND dedupe_key = ?").bind(deps.site, key).first<{ status: string }>();
  if (done && done.status !== 'failed') return ack(done.status === 'sent' ? 'welcome_duplicate' : `welcome_${done.status}`);
  const hold = await db.prepare('SELECT id FROM domain_holds WHERE domain = ? AND released_at IS NULL LIMIT 1').bind(deps.domain).first();
  if (hold) return later('welcome_domain_hold');
  const day = localDay(now, deps.utcOffsetHours);
  const health = await db.prepare('SELECT enforcement FROM throttle_days WHERE domain = ? AND day = ?').bind(deps.domain, day).first<{ enforcement: string | null }>();
  if (health?.enforcement && health.enforcement !== 'HEALTHY' && health.enforcement !== 'UNKNOWN') return later('welcome_provider_unhealthy');

  const from = parseAddress(w.from_addr);
  if (!from || !from.addr.endsWith(`@${deps.domain}`)) return ack('welcome_bad_from');
  const replyTo = w.reply_to ? parseAddress(w.reply_to) : null;

  // 內容先組好（缺退訂設定就不寄：沒有退訂連結的信一封都不出去）。
  let content: { html: string; text: string; headers: Record<string, string> };
  try {
    if (!deps.unsub.secrets.length || !deps.unsub.baseUrl) throw new Error('unsubscribe not configured');
    const links = await unsubscribeLinks(deps.unsub.secrets, { baseUrl: deps.unsub.baseUrl, mailtoAddress: deps.unsub.mailto }, { list: msg.list, contactId: msg.contact, campaign: null });
    content = personalize(
      { html: w.html, text: w.text, headers: { ...links.headers } },
      { name: safeName(member.name), email: member.email, web_url: w.web_url, unsubscribe_url: links.url },
    );
  } catch (e) {
    console.error('welcome render failed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    return ack('welcome_render_error');
  }

  // 今天的額度：跟群發共用同一個寄件網域的每日上限（先佔一格，沒寄出再還）。今天的列還沒建＝群發今天還沒讀過郵差上限，晚點再試。
  const reserved = await db.prepare('UPDATE throttle_days SET sent = sent + 1 WHERE domain = ? AND day = ? AND sent < "limit" RETURNING sent').bind(deps.domain, day).first<{ sent: number }>();
  if (!reserved) return later('welcome_no_quota');
  const refund = () => db.prepare('UPDATE throttle_days SET sent = MAX(sent - 1, 0) WHERE domain = ? AND day = ?').bind(deps.domain, day).run();

  const iso = now.toISOString();
  const claimed = await db
    .prepare(
      `INSERT INTO messages (stream, tier, site, dedupe_key, kind, to_email, from_addr, subject, status, attempts, created_at, updated_at)
       VALUES ('marketing', 'marketing', ?, ?, 'welcome', ?, ?, ?, 'sending', 1, ?, ?)
       ON CONFLICT (site, dedupe_key) DO UPDATE SET status = 'sending', last_error = COALESCE(messages.error, messages.last_error), error = NULL,
         attempts = messages.attempts + 1, updated_at = excluded.updated_at
       WHERE messages.status = 'failed'
       RETURNING id, attempts`,
    )
    .bind(deps.site, key, member.email, fmt(from), w.subject, iso, iso)
    .first<{ id: number; attempts: number }>();
  if (!claimed) {
    await refund();
    return ack('welcome_duplicate');
  }
  let out: PostmanOutcome;
  try {
    out = await deps.postman.send({
      from: fmt(from), to: member.email, subject: w.subject, html: content.html, text: content.text,
      ...(replyTo ? { replyTo: fmt(replyTo) } : {}),
      headers: content.headers,
      tags: { campaign: `_welcome-${msg.list}`, contact: String(msg.contact) },
      idempotencyKey: `${deps.site}/${key}`,
    });
  } catch (e) {
    // 不知道寄出沒有：帳本列留在 sending，不再自動重寄（寧可少一封也不寄兩封）。
    console.error('welcome postman threw', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    return ack('welcome_uncertain');
  }
  const t = (deps.now ?? (() => new Date()))().toISOString();
  if (out.ok) {
    await db.prepare("UPDATE messages SET status = 'sent', route = ?, provider_id = ?, updated_at = ?, sent_at = ? WHERE id = ?").bind(deps.postman.name, out.providerId, t, t, claimed.id).run();
    return ack('welcome_sent');
  }
  await refund();
  await db.prepare("UPDATE messages SET status = 'failed', route = ?, error = ?, updated_at = ? WHERE id = ?").bind(deps.postman.name, `${deps.postman.name} ${out.kind} ${out.error}`.slice(0, 200), t, claimed.id).run();
  if (out.kind === 'permanent' || claimed.attempts >= 5) return ack(`welcome_failed_${out.kind}`);
  return later(`welcome_${out.kind}`);
}

